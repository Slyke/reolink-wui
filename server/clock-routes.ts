import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clockFields, clockReading, clockConfirmed, clockOptionKeys, validClockChange } from '../shared/clock.js';
import { correlationPattern } from '../shared/urls.js';
import { record } from './bridge-channels.js';
import { sendOutcome } from './camera-routes.js';
import { Failure } from './errors.js';
import { jsonResponse } from './net.js';
import { input, uuid, type Runtime } from './runtime.js';

export function clockRoutes({api,path,runtime}: {api: FastifyInstance; path: string; runtime: Runtime}) {
  const endpoint = path + '/cameras/:id/clock';
  api.get<{Params:{id:string}}>(endpoint,async request => {
    const {row,bridge} = await runtime.camera({request,id:request.params.id,permission:'settings.clock.read'});
    if (!bridge.hasClock(row.routeId)) throw new Failure('UNSUPPORTED',422);
    const response = await bridge.api({path:'/cameras/'+row.routeId+'/clock',stableId:row.remote_id,correlation:request.id,signal:AbortSignal.timeout(21_000)});
    if (!response.ok) throw new Failure(response.status===409 ? 'CAMERA_UNKNOWN' : 'BRIDGE_UNAVAILABLE',502);
    const result = clockReading.safeParse(await jsonResponse({response}));
    if (!result.success) throw new Failure('BRIDGE_UNAVAILABLE',502);
    return result.data;
  });
  api.put<{Params:{id:string}}>(endpoint,async (request,reply) => {
    const {row,bridge,session} = await runtime.camera({request,id:request.params.id,permission:'settings.clock.write',mutate:true});
    if (!bridge.hasClock(row.routeId)) throw new Failure('UNSUPPORTED',422);
    const {operationId,...change} = input({schema:z.strictObject({operationId:uuid,...clockFields}).refine(validClockChange),value:request.body});
    const result = await runtime.ops.run({id:operationId,actor:session.account.id,resource:row.id,action:'settings.clock',correlation:request.id,input:change.cameraTime!==undefined && Object.keys(change).length===1 ? change.cameraTime : change,serialized:true,
      execute:async () => {
        const start=performance.now();
        const response=await bridge.api({path:'/cameras/'+row.routeId+'/clock',method:'PUT',stableId:row.remote_id,
          data:change,correlation:request.id,signal:AbortSignal.timeout(28_000)});
        const body=record(await jsonResponse({response}));
        const bridgeCorrelationId=typeof body.correlation_id==='string' && correlationPattern.test(body.correlation_id) ? body.correlation_id : undefined;
        const after=clockReading.safeParse(body).data;
        const settings=after?.settings;
        const zone=change.timeZone;
        const zoneMatches=!zone || (settings?.utcOffsetMinutes===zone.utcOffsetMinutes && settings.daylightSavingEnabled===Boolean(zone.daylightSaving));
        const optionsMatch=clockOptionKeys.every(key=>change[key]===undefined || (settings?.[key]===change[key] &&
          (change.cameraTime!==undefined || after?.editableOptions?.includes(key))));
        const timeMatches=change.cameraTime===undefined || (after?.cameraTime && clockConfirmed(change.cameraTime,after.cameraTime,performance.now()-start));
        if (response.ok && body.outcome==='confirmed' && after?.cameraTime && settings && zoneMatches && optionsMatch && timeMatches)
          return {outcome:'confirmed',bridgeCorrelationId,data:after};
        const reasons={API_CLOCK_NTP_ACTIVE:'CAMERA_CLOCK_NTP_ACTIVE',API_CLOCK_INVALID:'BAD_INPUT',API_CLOCK_REJECTED:'COMMAND_REJECTED',API_CLOCK_UNSUPPORTED:'UNSUPPORTED',API_DISPLAY_BUSY:'COMMAND_BUSY',
          API_READ_BUSY:'COMMAND_BUSY',API_CAMERA_IDENTITY_CHANGED:'CAMERA_UNKNOWN',API_CLOCK_READ_FAILED:'BRIDGE_UNAVAILABLE'} as const;
        const key=typeof body.errorKey==='string' && Object.hasOwn(reasons,body.errorKey) ? body.errorKey as keyof typeof reasons : undefined;
        return key ? {outcome:'rejected',reason:reasons[key],bridgeCorrelationId} : {outcome:'unverified',reason:'CAMERA_CLOCK_UNVERIFIED',bridgeCorrelationId};
      }
    });
    return sendOutcome({reply,value:result});
  });
}
