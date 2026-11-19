import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { camerasFor, type Account, type Sql } from './db.js';
import { input, uuid, type Runtime } from './runtime.js';
import { Failure, report } from './errors.js';
import { available, capabilities, statusPtz } from './cameras.js';
import { record } from './bridge-channels.js';
import { result } from './bridge.js';
import { validatePng } from './png.js';
import { bridgePreview } from './playback.js';
import { presetPreferences, readPresetPreferences } from '../shared/presets.js';
import type { ActionResult } from './operations.js';

type PresetPhoto = { image: Buffer; type: 'image/png' | 'image/jpeg' };
type Position = ReturnType<typeof statusPtz>['position'];
function coordinates(position: Position) {
  const { pan, tilt, zoom } = position;
  if (pan === undefined && tilt === undefined) return;
  return JSON.stringify([pan ?? null, tilt ?? null, zoom.position ?? null]);
}
export async function rememberPresetPosition(sql: Sql, camera: string, slot: number, name: string, position: Position) {
  const point = coordinates(position);
  if (!point) {
    await sql.query('DELETE FROM preset_positions WHERE camera=$1 AND slot=$2', camera, slot);
    return;
  }
  await sql.query('INSERT INTO preset_positions(camera,slot,name,position) VALUES ($1,$2,$3,$4) ON CONFLICT(camera,slot) DO UPDATE SET name=excluded.name,position=excluded.position', camera, slot, name, point);
}

export function presetRoutes({ api, cameras, runtime, sendOutcome }: {
  api: FastifyInstance; cameras: string; runtime: Runtime;
  sendOutcome: typeof import('./camera-routes.js').sendOutcome;
}) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closing = false;
  api.addHook('onClose', async () => {
    closing = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  });
  api.put<{Params:{id:string}}>(cameras+'/:id/ptz/preferences', async request => {
    const {row,grant,bridge} = await runtime.camera({request,id:request.params.id,permission:'ptz.write',mutate:true});
    if (!grant.has('ptz.read') || !capabilities({bridge,remote:row.routeId,grant}).ptz?.presets) throw new Failure('UNSUPPORTED',422);
    const settings = input({schema:presetPreferences,value:request.body});
    await runtime.sql.query('UPDATE cameras SET ptz_preferences=$1,ptz_intent=NULL WHERE id=$2', JSON.stringify(settings),row.id);
    return settings;
  });

  const scheduleReturn = (camera: string, actor: string, intent: string, slot: number, seconds: number, correlation: string) => {
    clearTimeout(timers.get(camera));
    const timer = setTimeout(async () => {
      timers.delete(camera);
      if (closing) return;
      try {
        const [account] = await runtime.sql.query<Account>('SELECT id,label,admin,enabled FROM accounts WHERE id=$1 AND enabled=1',actor);
        if (!account) return;
        const [row] = await camerasFor({sql:runtime.sql,account,id:camera});
        if (!row || row.ptz_intent !== intent || !row.permissions.includes('ptz.write')) return;
        const bridge = runtime.bridges.get(row.bridge_id), remote = bridge?.remoteId(row.remote_id);
        if (!bridge || !remote || !available({bridge,remote}).online) throw new Failure('CAMERA_OFFLINE',409);
        const operation = randomUUID();
        await runtime.ops.run({id:operation,actor,resource:camera,action:'ptz.return_preset',input:slot,correlation,
          serialized:true,reconcileGroup:'ptz',execute:async () => {
            const claimed = await runtime.sql.query('UPDATE cameras SET ptz_intent=$1 WHERE id=$2 AND ptz_intent=$3 RETURNING id',operation,camera,intent);
            if (!claimed.length) return {outcome:'rejected',reason:'PTZ_CANCELLED'};
            return result({reply:await bridge.command({id:operation,camera:remote,stableId:row.remote_id,
              command:{setting:'ptz',action:{op:'goto_preset',preset_id:slot}},correlation}),write:true});
          }});
      } catch (error) {
        report({error:error instanceof Failure ? error : new Failure('BRIDGE_UNAVAILABLE',502),correlationId:correlation,caller:'presets::return'});
      }
    }, seconds * 1000);
    timer.unref();
    timers.set(camera,timer);
  };

  api.post<{Params:{id:string}}>(cameras+'/:id/ptz/preset-snapshot', async (request,reply) => {
    const {row,bridge,grant,session} = await runtime.camera({request,id:request.params.id,permission:'ptz.write',mutate:true});
    if (!grant.has('capture') || !grant.has('ptz.read')) throw new Failure('ACCESS_DENIED',403);
    const caps = capabilities({bridge,remote:row.routeId,grant});
    if (!caps.ptz?.presets || !caps.presetSnapshot) throw new Failure('UNSUPPORTED',422);
    if (!available({bridge,remote:row.routeId}).online) throw new Failure('CAMERA_OFFLINE',409);
    const {operationId,presetId} = input({schema:z.strictObject({operationId:uuid,presetId:z.number().int().min(0).max(255)}),value:request.body});
    const actor = session.account.id, correlation = request.id;
    const command = (action: Record<string,unknown>) => bridge.command({id:randomUUID(),camera:row.routeId,stableId:row.remote_id,correlation,command:{setting:'ptz',action}});
    const readPosition = async () => {
      const response = await command({op:'status'});
      return response.ok === true && response.verified !== false ? statusPtz({raw:record(response.result)}).position : undefined;
    };
    const stillCurrent = async () => !closing && (await runtime.sql.query('SELECT id FROM cameras WHERE id=$1 AND ptz_intent=$2',row.id,operationId)).length > 0;
    const takePhoto = async (): Promise<ActionResult<PresetPhoto>> => {
      if (bridge.canCapture(row.routeId)) {
        const response = await bridge.command({id:randomUUID(),camera:row.routeId,stableId:row.remote_id,correlation,command:{setting:'snapshot'},capture:true});
        return {...result({reply:response,write:false}),data:response.ok === true ? {image:validatePng({result:response.result}),type:'image/png'} : undefined};
      }
      const {frame} = await bridgePreview({bridge,row,correlation,refresh:true});
      if (!frame) throw new Failure('SNAPSHOT_INVALID',502);
      return {outcome:'confirmed',data:{image:frame,type:'image/jpeg'}};
    };
    const operation = await runtime.ops.run<PresetPhoto>({id:operationId,actor,resource:row.id,action:'ptz.preset_snapshot',input:presetId,correlation,
      serialized:true,reconcileGroup:'ptz',execute:async ():Promise<ActionResult<PresetPhoto>> => {
        await runtime.sql.query('UPDATE cameras SET ptz_intent=$1 WHERE id=$2',operationId,row.id);
        const listed = await command({op:'list_presets'});
        if (listed.ok !== true) return {...result({reply:listed,write:false}), data:undefined};
        const presets = statusPtz({raw:record(listed.result)}).presets ?? [];
        const preset = presets.find(item=>item.id === presetId);
        if (!preset) return {outcome:'rejected',reason:'PTZ_PRESET_MISSING'};
        const [saved] = await runtime.sql.query<{position:string}>('SELECT position FROM preset_positions WHERE camera=$1 AND slot=$2 AND name=$3',row.id,presetId,preset.name ?? '');
        const before = await readPosition();
        const origin = before && coordinates(before);
        if (!origin) return {outcome:'rejected',reason:'PTZ_ARRIVAL_UNVERIFIED'};
        if (!await stillCurrent()) return {outcome:'rejected',reason:'PTZ_CANCELLED'};
        const move = await command({op:'goto_preset',preset_id:presetId});
        if (move.ok !== true) return {...result({reply:move,write:true}),data:undefined};
        let last: string | undefined, stable = 0, moved = false;
        const until = Date.now() + 12_000;
        while (Date.now() < until) {
          await delay(300);
          if (!await stillCurrent()) return {outcome:'rejected',reason:'PTZ_CANCELLED'};
          const position = await readPosition(), point = position && coordinates(position);
          if (!point || !position) { stable = 0; last = undefined; continue; }
          if (point !== origin) moved = true;
          stable = point === last ? stable + 1 : 1;
          last = point;
          // Older camera presets expose only a name and slot. For their first visit
          // require actual travel followed by three matching camera position reports.
          if (stable < 3 || (saved ? point !== saved.position : !moved)) continue;
          if (!await stillCurrent()) return {outcome:'rejected',reason:'PTZ_CANCELLED'};
          if (!saved) await rememberPresetPosition(runtime.sql,row.id,presetId,preset.name ?? '',position);
          const prefs = readPresetPreferences(row.ptz_preferences);
          try {
            return await takePhoto();
          } finally {
            if (prefs.returnPreset !== null && prefs.returnPreset !== presetId && presets.some(item=>item.id === prefs.returnPreset) && await stillCurrent()) {
              scheduleReturn(row.id,actor,operationId,prefs.returnPreset,prefs.returnSeconds,correlation);
            }
          }
        }
        return {outcome:'unverified',reason:'PTZ_ARRIVAL_UNVERIFIED',bridgeCorrelationId:result({reply:move,write:true}).bridgeCorrelationId};
      }});
    if (!operation.data) return sendOutcome({reply,value:operation});
    const { image, type } = operation.data;
    const extension = type === 'image/jpeg' ? 'jpg' : 'png';
    return reply.type(type).header('content-disposition','inline; filename="preset-'+presetId+'.'+extension+'"').send(image);
  });
  return scheduleReturn;
}
