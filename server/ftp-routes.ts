import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ftpChanges, ftpDestination } from '../shared/ftp.js';
import { correlationPattern } from '../shared/urls.js';
import { record } from './bridge-channels.js';
import { sendOutcome } from './camera-routes.js';
import { Failure } from './errors.js';
import { jsonResponse } from './net.js';
import { input, uuid, type Runtime } from './runtime.js';

const reasons = {
  API_DEVICE_OPTIONS_INVALID:'BAD_INPUT', API_DEVICE_OPTIONS_UNSUPPORTED:'UNSUPPORTED', API_DEVICE_OPTIONS_REJECTED:'CAMERA_OPTION_REJECTED',
  API_READ_BUSY:'COMMAND_BUSY', API_DISPLAY_BUSY:'COMMAND_BUSY', API_CAMERA_IDENTITY_CHANGED:'CAMERA_UNKNOWN', API_DEVICE_OPTIONS_READ_FAILED:'CAMERA_OPTION_READ_FAILED'
} as const;
const destination = (routeId:string) => '/cameras/'+routeId+'/options/ftpDestination';

export function ftpRoutes({api,path,runtime}:{api:FastifyInstance;path:string;runtime:Runtime}){
  const endpoint=path+'/cameras/:id/ftp';
  api.get<{Params:{id:string}}>(endpoint,async request=>{
    const {row,bridge}=await runtime.camera({request,id:request.params.id,permission:'settings.delivery.read'});
    if(!bridge.has('ftpDestination') || !bridge.hasDisplay(row.routeId))throw new Failure('UNSUPPORTED',422);
    const response=await bridge.api({path:destination(row.routeId),stableId:row.remote_id,correlation:request.id,signal:AbortSignal.timeout(21_000)});
    const body=record(await jsonResponse({response}));
    if(response.status===422 && body.errorKey==='API_DEVICE_OPTIONS_UNSUPPORTED')return {supported:false};
    if(!response.ok){
      if(response.status===409)throw new Failure('CAMERA_UNKNOWN',409);
      throw new Failure(body.errorKey==='API_READ_BUSY'?'COMMAND_BUSY':'CAMERA_OPTION_READ_FAILED',502);
    }
    const view=ftpDestination.safeParse(body);
    if(!view.success)throw new Failure('CAMERA_OPTION_READ_FAILED',502);
    return {supported:true,...view.data};
  });
  api.put<{Params:{id:string}}>(endpoint,async(request,reply)=>{
    const {row,bridge,session}=await runtime.camera({request,id:request.params.id,permission:'settings.delivery.write',mutate:true});
    if(!bridge.has('ftpDestination') || !bridge.hasDisplay(row.routeId) || !bridge.config.http)throw new Failure('UNSUPPORTED',422);
    const {operationId,fields}=input({schema:z.strictObject({operationId:uuid,fields:ftpChanges}),value:request.body});
    const intent=createHmac('sha256',bridge.config.http.token).update(JSON.stringify([operationId,fields])).digest('hex');
    const value=await runtime.ops.run({id:operationId,actor:session.account.id,resource:row.id,action:'settings.ftp.destination',correlation:request.id,input:intent,serialized:true,execute:async()=>{
      const response=await bridge.api({path:destination(row.routeId),stableId:row.remote_id,method:'PUT',data:{fields},correlation:request.id,signal:AbortSignal.timeout(30_000)});
      const body=record(await jsonResponse({response}));
      const bridgeCorrelationId=typeof body.correlation_id==='string' && correlationPattern.test(body.correlation_id)?body.correlation_id:undefined;
      const view=ftpDestination.safeParse(body);
      if(response.ok && view.success && (body.outcome==='confirmed' || body.outcome==='unverified')){
        const matches=Object.entries(fields).every(([key,val])=>key==='password' || view.data.fields[key as keyof typeof view.data.fields]===val);
        if(matches)return {outcome:body.outcome,bridgeCorrelationId,data:view.data};
      }
      const key=typeof body.errorKey==='string' && Object.hasOwn(reasons,body.errorKey)?body.errorKey as keyof typeof reasons:undefined;
      return key?{outcome:'rejected',reason:reasons[key],bridgeCorrelationId}:{outcome:'unverified',reason:'CAMERA_OPTION_UNVERIFIED',bridgeCorrelationId};
    }});
    return sendOutcome({reply,value});
  });
}
