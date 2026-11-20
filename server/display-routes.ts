import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { displayChange, displayFields } from '../shared/display.js';
import { correlationPattern } from '../shared/urls.js';
import { sendOutcome } from './camera-routes.js';
import { record } from './bridge-channels.js';
import { jsonResponse } from './net.js';
import { Failure } from './errors.js';
import { input, uuid, type Runtime } from './runtime.js';

export function displayRoutes({api,path,runtime}: {api: FastifyInstance; path: string; runtime: Runtime}) {
  const endpoint = path + '/cameras/:id/display';
  api.get<{Params:{id:string}}>(endpoint,async request => {
    const {row,bridge} = await runtime.camera({request,id:request.params.id,permission:'settings.image.read'});
    if (!bridge.hasDisplay(row.routeId)) throw new Failure('UNSUPPORTED',422);
    const response = await bridge.api({path:'/cameras/'+row.routeId+'/display',stableId:row.remote_id,correlation:request.id,signal:AbortSignal.timeout(23_000)});
    const body = record(await jsonResponse({response}));
    if (!response.ok) throw new Failure(response.status === 409 ? 'CAMERA_UNKNOWN' : 'BRIDGE_UNAVAILABLE',502);
    const settings = displayFields.safeParse(body.fields);
    if (!settings.success) throw new Failure('BRIDGE_UNAVAILABLE',502);
    return {fields:settings.data};
  });
  api.put<{Params:{id:string}}>(endpoint,async (request,reply) => {
    const {row,bridge,session} = await runtime.camera({request,id:request.params.id,permission:'settings.image.write',mutate:true});
    if (!bridge.hasDisplay(row.routeId)) throw new Failure('UNSUPPORTED',422);
    const {operationId,fields} = input({schema:z.strictObject({operationId:uuid,fields:displayChange}),value:request.body});
    const result = await runtime.ops.run({
      id:operationId,actor:session.account.id,resource:row.id,action:'settings.display',correlation:request.id,input:fields,serialized:true,
      execute:async () => {
        const response = await bridge.api({path:'/cameras/'+row.routeId+'/display',method:'PUT',stableId:row.remote_id,
          data:{fields},correlation:request.id,signal:AbortSignal.timeout(30_000)});
        const body = record(await jsonResponse({response}));
        const bridgeCorrelationId = typeof body.correlation_id === 'string' && correlationPattern.test(body.correlation_id) ? body.correlation_id : undefined;
        const after = displayFields.safeParse(body.fields);
        if (response.ok && body.outcome === 'confirmed' && after.success
          && Object.entries(fields).every(([key,value])=>after.data[key as keyof typeof fields]===value))
          return {outcome:'confirmed',bridgeCorrelationId,data:after.data};
        const reasons = {API_DISPLAY_REJECTED:'COMMAND_REJECTED',API_DISPLAY_INVALID:'BAD_INPUT',API_DISPLAY_UNSUPPORTED:'UNSUPPORTED',
          API_DISPLAY_BUSY:'COMMAND_BUSY',API_READ_BUSY:'COMMAND_BUSY',API_CAMERA_IDENTITY_CHANGED:'CAMERA_UNKNOWN',API_DISPLAY_READ_FAILED:'BRIDGE_UNAVAILABLE'} as const;
        const reason = typeof body.errorKey==='string' ? reasons[body.errorKey as keyof typeof reasons] : undefined;
        return reason && Object.hasOwn(reasons,body.errorKey as string) ? {outcome:'rejected',reason,bridgeCorrelationId}
          : {outcome:'unverified',reason:'OUTCOME_UNKNOWN',bridgeCorrelationId};
      }
    });
    return sendOutcome({reply,value:result});
  });
}
