import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isOptionGroup, optionPermission, optionValue, readOptionView, validOptionChange } from '../shared/device-options.js';
import { correlationPattern } from '../shared/urls.js';
import { record } from './bridge-channels.js';
import { sendOutcome } from './camera-routes.js';
import { Failure } from './errors.js';
import { jsonResponse } from './net.js';
import { input,uuid,type Runtime } from './runtime.js';

type Params={id:string;group:string};
export function deviceOptionsRoutes({api,path,runtime}:{api:FastifyInstance;path:string;runtime:Runtime}){
  const endpoint=path+'/cameras/:id/options/:group';
  api.get<{Params:Params}>(endpoint,async request=>{
    const {id,group}=request.params;
    if(!isOptionGroup(group))throw new Failure('BAD_INPUT',400);
    const {row,bridge}=await runtime.camera({request,id,permission:optionPermission(group,'read')});
    if(group==='tracking')await runtime.camera({request,id,permission:'ptz.read'});
    if(!bridge.has('deviceOptions') || !bridge.hasDisplay(row.routeId))throw new Failure('UNSUPPORTED',422);
    const response=await bridge.api({path:'/cameras/'+row.routeId+'/options/'+group,stableId:row.remote_id,correlation:request.id,signal:AbortSignal.timeout(21_000)});
    const body=record(await jsonResponse({response}));
    if(response.status===422 && body.errorKey==='API_DEVICE_OPTIONS_UNSUPPORTED')return {fields:{}};
    if(!response.ok)throw new Failure(response.status===409?'CAMERA_UNKNOWN':body.errorKey==='API_READ_BUSY'?'COMMAND_BUSY':'CAMERA_OPTION_READ_FAILED',response.status===409?409:502);
    const view=readOptionView(group,body);
    if(!view)throw new Failure('CAMERA_OPTION_READ_FAILED',502);
    return view;
  });
  api.put<{Params:Params}>(endpoint,async(request,reply)=>{
    const {id,group}=request.params;
    if(!isOptionGroup(group))throw new Failure('BAD_INPUT',400);
    const {row,bridge,session}=await runtime.camera({request,id,permission:optionPermission(group,'write'),mutate:true});
    if(group==='tracking')await runtime.camera({request,id,permission:'ptz.write',mutate:true});
    if(!bridge.has('deviceOptions') || !bridge.hasDisplay(row.routeId))throw new Failure('UNSUPPORTED',422);
    const {operationId,fields}=input({schema:z.strictObject({operationId:uuid,fields:z.record(z.string(),optionValue).refine(input=>validOptionChange(group,input))}),value:request.body});
    const result=await runtime.ops.run({id:operationId,actor:session.account.id,resource:row.id,action:'settings.options.'+group,correlation:request.id,input:fields,serialized:true,
      execute:async()=>{
        const response=await bridge.api({path:'/cameras/'+row.routeId+'/options/'+group,method:'PUT',stableId:row.remote_id,data:{fields},correlation:request.id,signal:AbortSignal.timeout(30_000)});
        const body=record(await jsonResponse({response}));
        const bridgeCorrelationId=typeof body.correlation_id==='string' && correlationPattern.test(body.correlation_id)?body.correlation_id:undefined;
        const observed=readOptionView(group,body);
        if(response.ok && body.outcome==='confirmed' && observed && Object.entries(fields).every(([key,value])=>observed.fields[key]?.value===value))
          return {outcome:'confirmed',bridgeCorrelationId,data:observed};
        const reasons={API_DEVICE_OPTIONS_INVALID:'BAD_INPUT',API_DEVICE_OPTIONS_UNSUPPORTED:'UNSUPPORTED',API_DEVICE_OPTIONS_REJECTED:'CAMERA_OPTION_REJECTED',
          API_READ_BUSY:'COMMAND_BUSY',API_DISPLAY_BUSY:'COMMAND_BUSY',API_CAMERA_IDENTITY_CHANGED:'CAMERA_UNKNOWN',API_DEVICE_OPTIONS_READ_FAILED:'CAMERA_OPTION_READ_FAILED'} as const;
        const key=typeof body.errorKey==='string' && Object.hasOwn(reasons,body.errorKey)?body.errorKey as keyof typeof reasons:undefined;
        return key?{outcome:'rejected',reason:reasons[key],bridgeCorrelationId}:{outcome:'unverified',reason:'CAMERA_OPTION_UNVERIFIED',bridgeCorrelationId};
      }
    });
    return sendOutcome({reply,value:result});
  });
}
