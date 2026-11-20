import type { FastifyInstance } from 'fastify';
import { audit } from './db.js';
import { Failure, recordError } from './errors.js';
import type { Runtime } from './runtime.js';
import { input, uuid } from './runtime.js';
import { MediaRetention, mediaKinds, mediaRequest, mediaSupport, retentionSettings, type MediaKind } from './media-retention.js';

export function retentionRoutes({api,path,runtime}:{api:FastifyInstance;path:string;runtime:Runtime}) {
  const worker=new MediaRetention(runtime);
  api.addHook('onReady',async()=>{worker.start();});
  api.addHook('onClose',async()=>{await worker.close();});
  const resource=path+'/cameras/:id/media-retention';
  const read=(camera:string)=>runtime.sql.query<{kind:MediaKind;days:number;last_checked:string|null;last_deleted:number;last_skipped:number;last_error:string|null;last_reference:string|null}>(
    'SELECT kind,days,last_checked,last_deleted,last_skipped,last_error,last_reference FROM media_retention WHERE camera=$1',camera);
  const lookup=async(id:string)=>{
    const [row]=await runtime.sql.query<{id:string;bridge_id:string;remote_id:string}>('SELECT id,bridge_id,remote_id FROM cameras WHERE id=$1',input({schema:uuid,value:id}));
    if (!row) throw new Failure('CAMERA_UNKNOWN',404);
    const bridge=runtime.bridges.get(row.bridge_id), route=bridge?.remoteId(row.remote_id);
    return {row,bridge,route};
  };
  api.get<{Params:{id:string}}>(resource,async request=>{
    await runtime.admin({request});
    const {bridge,route,row}=await lookup(request.params.id);
    const rules=await read(row.id);
    if (!bridge || !route || !bridge.hasMediaFiles(route)) return {rules,support:null,unavailable:!route};
    try {
      const caps=await mediaRequest({bridge,route,stable:row.remote_id,correlation:request.id},'capabilities',mediaSupport);
      return {rules,support:{video:caps.video,timeLapse:caps.timeLapse}};
    } catch (cause) {
      recordError({key:'MEDIA_RETENTION_FAILED',caller:'retention::capabilities',correlationId:request.id,context:{camera:row.id,...(cause instanceof Failure ? cause.details : {})}});
      return {rules,support:null,unavailable:true};
    }
  });
  api.put<{Params:{id:string}}>(resource,async request=>{
    const {account}=await runtime.admin({request,mutate:true});
    const {bridge,route,row}=await lookup(request.params.id);
    const settings=input({schema:retentionSettings,value:request.body});
    const existing=await read(row.id);
    const changed=mediaKinds.filter(kind=>settings[kind]!==null && settings[kind]!==existing.find(rule=>rule.kind===kind)?.days);
    let source='';
    if (changed.length) {
      if (!bridge || !route || !bridge.hasMediaFiles(route)) throw new Failure('UNSUPPORTED',422);
      const caps=await mediaRequest({bridge,route,stable:row.remote_id,correlation:request.id},'capabilities',mediaSupport);
      if (changed.some(kind=>!caps[kind])) throw new Failure('UNSUPPORTED',422);
      source=caps.source;
    }
    await runtime.sql.transaction(async query=>{
      // Serialize edits to both rules, including a camera that has no rules yet.
      await query('UPDATE cameras SET id=id WHERE id=$1',row.id);
      const current=await query<{kind:MediaKind;days:number}>('SELECT kind,days FROM media_retention WHERE camera=$1',row.id);
      if (mediaKinds.some(kind=>current.find(rule=>rule.kind===kind)?.days !== existing.find(rule=>rule.kind===kind)?.days)) {
        throw new Failure('OPERATION_CONFLICT',409);
      }
      for (const kind of mediaKinds) {
        const days=settings[kind];
        if (days===null) await query('DELETE FROM media_retention WHERE camera=$1 AND kind=$2',row.id,kind);
        else if (changed.includes(kind)) await query(
          'INSERT INTO media_retention(camera,kind,days,source) VALUES($1,$2,$3,$4) ON CONFLICT(camera,kind) DO UPDATE SET days=excluded.days,source=excluded.source,'
          +'next_check=0,lease=NULL,lease_until=0,last_cutoff=NULL,history_month=NULL,last_error=NULL,last_reference=NULL,last_checked=NULL,last_deleted=0,last_skipped=0 '
          +'WHERE media_retention.days<>excluded.days OR media_retention.source<>excluded.source',row.id,kind,days,source);
      }
      await audit({query,actor:account.id,resource:row.id,action:'retention.settings',outcome:'confirmed',correlation:request.id});
    });
    return {rules:await read(row.id)};
  });
}
