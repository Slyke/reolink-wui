import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { recordingDate, recordingId } from '../shared/recordings.js';
import { audit } from './db.js';
import { Failure, recordError } from './errors.js';
import { jsonResponse } from './net.js';
import type { Bridge } from './bridge.js';
import type { Runtime } from './runtime.js';

export const mediaKinds = ['video','timeLapse'] as const;
export type MediaKind = typeof mediaKinds[number];
const days = z.number().int().positive().max(36500).nullable();
export const retentionSettings = z.strictObject({ video:days, timeLapse:days });
const instant = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/).refine(s => {
  const t=Date.parse(s+'Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0,19) === s;
});
export const mediaSupport = z.object({ source:recordingId, video:z.boolean(), timeLapse:z.boolean(), cameraTime:instant });
const dayList = z.object({days:z.array(recordingDate).max(36600)});
const fileList = z.object({source:recordingId, files:z.array(z.object({id:recordingId, completedAt:instant})).max(40_000), skipped:z.number().int().nonnegative()});
const deletedFiles = z.object({deleted:z.array(recordingId).max(1024), absent:z.array(recordingId).max(1024)});
const hour = 3_600_000;
const leaseTime = 180_000;

type Rule = {camera:string;kind:MediaKind;days:number;source:string;last_cutoff:string|null;history_month:string|null;bridge_id:string;remote_id:string};
type Target = {bridge:Bridge; route:string; stable:string; correlation:string; signal?:AbortSignal};
type ReadOptions = {query?:Record<string,string>;body?:unknown};
export async function mediaRequest<T>(target:Target, path:string, schema:z.ZodType<T>, {query, body}:ReadOptions = {}) {
  const timeout=AbortSignal.timeout(125_000);
  const response=await target.bridge.api({path:'/cameras/'+target.route+'/media/'+path, stableId:target.stable,
    correlation:target.correlation, signal:target.signal ? AbortSignal.any([target.signal,timeout]) : timeout,
    search:query ? '?'+new URLSearchParams(query) : undefined, data:body});
  if (!response.ok) {
    const failure=await jsonResponse({response,limit:8192}).catch(()=>undefined) as {correlation_id?:string}|undefined;
    throw new Failure('MEDIA_RETENTION_FAILED',502,undefined,{upstreamStatus:response.status,bridgeCorrelationId:failure?.correlation_id});
  }
  const parsed=schema.safeParse(await jsonResponse({response,limit:6*1024*1024}));
  if (!parsed.success) throw new Failure('MEDIA_RETENTION_FAILED',502);
  return parsed.data;
}

const monthOf=(date:string)=>date.slice(0,7)+'-01';
function priorMonth(month:string) {
  const d=new Date(month+'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth()-1);
  return d.toISOString().slice(0,10);
}

export class MediaRetention {
  private timer?:ReturnType<typeof setInterval>;
  private task?:Promise<void>;
  private stop=new AbortController();
  constructor(private runtime:Pick<Runtime,'sql'|'bridges'>) {}

  start() {
    this.timer=setInterval(()=>{void this.checkDue();},60_000);
    this.timer.unref();
    void this.checkDue();
  }
  async close() {
    clearInterval(this.timer);
    this.stop.abort();
    await this.task;
  }
  checkDue() {
    if (this.stop.signal.aborted) return Promise.resolve();
    return this.task ??= this.run().catch(()=>{
      if (!this.stop.signal.aborted) recordError({key:'MEDIA_RETENTION_FAILED',caller:'retention::schedule'});
    }).finally(()=>{this.task=undefined;});
  }
  private async run() {
    const now=Date.now();
    const rules=await this.runtime.sql.query<Rule>(
      'SELECT r.camera,r.kind,r.days,r.source,r.history_month,r.last_cutoff,c.bridge_id,c.remote_id FROM media_retention r JOIN cameras c ON c.id=r.camera '
      +'WHERE r.next_check<=$1 AND r.lease_until<=$1 ORDER BY r.camera,r.kind',now);
    const cameras=Map.groupBy(rules,rule=>rule.camera);
    const queue=[...cameras.values()];
    const work=async()=>{
      for (let group=queue.shift();group && !this.stop.signal.aborted;group=queue.shift()) {
        for (const rule of group) await this.checkRule(rule);
      }
    };
    await Promise.all(Array.from({length:Math.min(3,queue.length)},work));
  }
  private async checkRule(rule:Rule) {
    const {sql,bridges}=this.runtime, {camera,kind}=rule;
    const token=randomUUID(), now=Date.now();
    const claimed=await sql.query(
      'UPDATE media_retention SET lease=$1,lease_until=$2 WHERE camera=$3 AND kind=$4 AND next_check<=$5 AND lease_until<=$5 AND days=$6 AND source=$7 RETURNING camera',
      token,now+leaseTime,camera,kind,now,rule.days,rule.source);
    if (!claimed.length) return;
    let deleted=0, skipped=0, lastCutoff=rule.last_cutoff, history=rule.history_month, failure:string|null=null;
    const bridge=bridges.get(rule.bridge_id);
    const route=bridge?.remoteId(rule.remote_id);
    const check=async()=>{
      this.stop.signal.throwIfAborted();
      if (!bridge || bridges.get(rule.bridge_id)!==bridge || bridge.remoteId(rule.remote_id)!==route) throw new Failure('CAMERA_UNKNOWN',404);
      const locked=await sql.query('UPDATE media_retention SET lease_until=$1 WHERE camera=$2 AND kind=$3 AND lease=$4 RETURNING camera',Date.now()+leaseTime,camera,kind,token);
      if (!locked.length) throw new Error('rule changed');
    };
    try {
      if (!bridge || !route || !bridge.hasMediaFiles(route)) throw new Failure('UNSUPPORTED',422);
      const target={bridge,route,stable:rule.remote_id,correlation:token,signal:this.stop.signal};
      const support=await mediaRequest(target,'capabilities',mediaSupport);
      if (support.source!==rule.source || !support[kind]) throw new Failure('UNSUPPORTED',422);
      const cutoff=new Date(Date.parse(support.cameraTime+'Z')-rule.days*86_400_000).toISOString().slice(0,19);
      const lastDay=cutoff.slice(0,10), newestMonth=monthOf(lastDay);
      const processDays=async(dates:string[])=>{
        for (const date of [...new Set(dates)].filter(d=>d<=lastDay).sort()) {
          await check();
          const list=await mediaRequest(target,'files',fileList,{query:{kind,date}});
          if (list.source!==rule.source) throw new Failure('CAMERA_UNKNOWN',409);
          skipped+=list.skipped;
          const expired=[...new Set(list.files.filter(f=>f.completedAt<cutoff).map(f=>f.id))];
          for (let i=0;i<expired.length;i+=1024) {
            await check();
            const files=expired.slice(i,i+1024);
            const result=await mediaRequest(target,'delete',deletedFiles,{body:{source:rule.source,kind,date,files}});
            const accounted=new Set([...result.deleted,...result.absent]);
            if (accounted.size!==files.length || result.deleted.length+result.absent.length!==files.length || files.some(id=>!accounted.has(id))) throw new Failure('MEDIA_RETENTION_FAILED',502);
            deleted+=result.deleted.length;
          }
        }
      };
      if (kind==='timeLapse') {
        await processDays((await mediaRequest(target,'days',dayList,{query:{kind}})).days);
      } else {
        const month=async(value:string)=>{
          await check();
          const list=await mediaRequest(target,'days',dayList,{query:{kind,month:value}});
          if (list.days.some(d=>monthOf(d)!==value)) throw new Failure('MEDIA_RETENTION_FAILED',502);
          await processDays(list.days);
        };
        // Revisit newly expired dates after downtime, then backfill older monthly camera calendars.
        // A video starting the previous day may finish after midnight in the cutoff month.
        const dayBefore=new Date(Date.parse(lastDay+'T00:00:00Z')-86_400_000).toISOString().slice(0,10);
        const first=lastCutoff && lastCutoff.slice(0,10)<dayBefore ? monthOf(lastCutoff) : monthOf(dayBefore);
        for (let m=newestMonth;m>=first;m=priorMonth(m)) await month(m);
        const prior=priorMonth(first);
        if (!history || history>prior || history<'1970-01-01') history=prior;
        for (let i=0;i<12 && history>='1970-01-01';i++) {
          await month(history);
          history=priorMonth(history);
        }
      }
      lastCutoff=cutoff;
    } catch (cause) {
      if (!this.stop.signal.aborted) {
        const owned=await sql.query('SELECT camera FROM media_retention WHERE camera=$1 AND kind=$2 AND lease=$3',camera,kind,token);
        if (owned.length) {
          failure=cause instanceof Failure ? cause.key : 'MEDIA_RETENTION_FAILED';
          recordError({key:'MEDIA_RETENTION_FAILED',caller:'retention::check',correlationId:token,context:{camera,kind,reason:failure,...(cause instanceof Failure ? cause.details : {})}});
        }
      }
    } finally {
      if (this.stop.signal.aborted) {
        await sql.query('UPDATE media_retention SET lease=NULL,lease_until=0 WHERE camera=$1 AND kind=$2 AND lease=$3',camera,kind,token);
      } else await sql.transaction(async query=>{
        const updated=await query(
          'UPDATE media_retention SET lease=NULL,lease_until=0,next_check=$1,last_checked=$2,last_deleted=$3,last_skipped=$4,last_error=$5,last_reference=$6,last_cutoff=$7,history_month=$8 WHERE camera=$9 AND kind=$10 AND lease=$11 RETURNING camera',
          Date.now()+hour,new Date().toISOString(),deleted,skipped,failure,token,lastCutoff,history,camera,kind,token);
        if (updated.length && (deleted || failure)) await audit({query,resource:camera,action:'retention.'+kind,outcome:failure?'failed':'confirmed',correlation:token});
      });
    }
  }
}
