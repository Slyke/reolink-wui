import type { FastifyInstance } from 'fastify';
import { cameraEncoding, encoderChange } from '../shared/encoding.js';
import { correlationPattern } from '../shared/urls.js';
import { record } from './bridge-channels.js';
import { sendOutcome } from './camera-routes.js';
import { Failure } from './errors.js';
import { jsonResponse } from './net.js';
import { input, uuid, type Runtime } from './runtime.js';

export function encodingRoutes({api,path,runtime}: {api:FastifyInstance;path:string;runtime:Runtime}) {
  const endpoint = path + '/cameras/:id/encoding';
  api.get<{Params:{id:string}}>(endpoint,async request => {
    const {row,bridge}=await runtime.camera({request,id:request.params.id,permission:'settings.encoding.read'});
    if (!bridge.hasEncoding(row.routeId)) throw new Failure('UNSUPPORTED',422);
    const response=await bridge.api({path:'/cameras/'+row.routeId+'/encoding',stableId:row.remote_id,correlation:request.id,signal:AbortSignal.timeout(24_000)});
    if (!response.ok) throw new Failure(response.status===409?'CAMERA_UNKNOWN':'BRIDGE_UNAVAILABLE',502);
    const result=cameraEncoding.safeParse(await jsonResponse({response}));
    if (!result.success) throw new Failure('BRIDGE_UNAVAILABLE',502);
    return result.data;
  });
  api.put<{Params:{id:string}}>(endpoint,async (request,reply) => {
    const {row,bridge,session}=await runtime.camera({request,id:request.params.id,permission:'settings.encoding.write',mutate:true});
    if (!bridge.hasEncoding(row.routeId)) throw new Failure('UNSUPPORTED',422);
    const {operationId,...change}=input({schema:encoderChange.extend({operationId:uuid}),value:request.body});
    const result=await runtime.ops.run({id:operationId,actor:session.account.id,resource:row.id,action:'settings.encoding',correlation:request.id,input:change,serialized:true,
      execute:async () => {
        const response=await bridge.api({path:'/cameras/'+row.routeId+'/encoding',method:'PUT',stableId:row.remote_id,data:change,correlation:request.id,signal:AbortSignal.timeout(34_000)});
        const body=record(await jsonResponse({response}));
        const bridgeCorrelationId=typeof body.correlation_id==='string' && correlationPattern.test(body.correlation_id)?body.correlation_id:undefined;
        const result=cameraEncoding.safeParse(body);
        if (response.ok && body.outcome==='confirmed' && result.success) {
          const current=result.data.profiles.find(p=>p.stream===change.stream)?.current;
          if (current && Object.entries(change.settings).every(([key,want])=>current[key as keyof typeof current]===want))
            return {outcome:'confirmed',bridgeCorrelationId,data:result.data};
        }
        const reasons={API_ENCODING_INVALID:'BAD_INPUT',API_ENCODING_REJECTED:'COMMAND_REJECTED',API_ENCODING_UNSUPPORTED:'UNSUPPORTED',API_READ_BUSY:'COMMAND_BUSY',
          API_DISPLAY_BUSY:'COMMAND_BUSY',API_CAMERA_IDENTITY_CHANGED:'CAMERA_UNKNOWN',API_ENCODING_READ_FAILED:'BRIDGE_UNAVAILABLE'} as const;
        const key=typeof body.errorKey==='string' && Object.hasOwn(reasons,body.errorKey)?body.errorKey as keyof typeof reasons:undefined;
        return key?{outcome:'rejected',reason:reasons[key],bridgeCorrelationId}:{outcome:'unverified',reason:'OUTCOME_UNKNOWN',bridgeCorrelationId};
      }
    });
    return sendOutcome({reply,value:result});
  });
}
