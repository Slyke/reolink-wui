import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { firmwareFilename, firmwareSource, firmwareView, maxFirmwareBytes } from '../shared/firmware.js';
import { correlationPattern } from '../shared/urls.js';
import { record } from './bridge-channels.js';
import { sendOutcome } from './camera-routes.js';
import { Failure } from './errors.js';
import { jsonResponse } from './net.js';
import { input, uuid, type Runtime } from './runtime.js';

const selection = z.strictObject({operationId:uuid, source:firmwareSource, confirm:z.literal('true'), file:firmwareFilename.optional()});
type Params = {id:string};
const reasons = {
  API_CAMERA_IDENTITY_CHANGED:'CAMERA_UNKNOWN', API_READ_BUSY:'COMMAND_BUSY',
  API_FIRMWARE_READ_FAILED:'FIRMWARE_READ_FAILED', API_FIRMWARE_INVALID:'BAD_INPUT', API_SCOPE_DENIED:'ACCESS_DENIED',
  API_FIRMWARE_UNSUPPORTED:'UNSUPPORTED', API_FIRMWARE_NO_OFFER:'FIRMWARE_NO_OFFER', API_FIRMWARE_REJECTED:'FIRMWARE_REJECTED'
} as const;

export function firmwareRoutes({api,path,runtime}:{api:FastifyInstance; path:string; runtime:Runtime}) {
  const endpoint=path+'/cameras/:id/firmware';
  const access=async(request:FastifyRequest<{Params:Params}>,write:boolean)=>{
    const camera=await runtime.camera({request,id:request.params.id,permission:write?'device.firmware.update':'device.firmware.read',mutate:write});
    if (!camera.bridge.hasFirmware(camera.row.routeId)) throw new Failure('UNSUPPORTED',422);
    return camera;
  };

  api.get<{Params:Params}>(endpoint,async request=>{
    const {bridge,row}=await access(request,false);
    const query=input({schema:z.strictObject({check:z.enum(['true','false']).optional()}),value:request.query});
    const response=await bridge.api({path:'/cameras/'+row.routeId+'/firmware',stableId:row.remote_id,
      search:query.check==='true'?'?check=true':undefined,correlation:request.id,signal:AbortSignal.timeout(45_000)});
    const body=await jsonResponse({response});
    if (!response.ok) throw new Failure(response.status===409?'CAMERA_UNKNOWN':response.status===503?'COMMAND_BUSY':'FIRMWARE_READ_FAILED',response.status);
    const checked=firmwareView.safeParse(body);
    if (!checked.success) throw new Failure('FIRMWARE_READ_FAILED',502);
    return checked.data;
  });

  // Only authenticated camera updaters can allocate a package buffer. Keep the normal JSON limit everywhere else.
  api.register(async scoped=>{
    scoped.addContentTypeParser('application/octet-stream',{parseAs:'buffer',bodyLimit:maxFirmwareBytes},(_req,body,done)=>done(null,body));
    const uploads=new Set<FastifyRequest>();
    scoped.addHook('onResponse',async req=>{uploads.delete(req);});
    scoped.addHook('onRequestAbort',async req=>{uploads.delete(req);});
    scoped.addHook('onTimeout',async req=>{uploads.delete(req);});
    scoped.post<{Params:Params}>(endpoint,{bodyLimit:maxFirmwareBytes, onRequest:async request=>{
      await access(request,true);
      const {file}=input({schema:selection,value:request.query});
      const binary=request.headers['content-type']==='application/octet-stream';
      if (Boolean(file)!==binary || (!file && (request.headers['transfer-encoding'] || Number(request.headers['content-length']??0)>0))) throw new Failure('BAD_INPUT',400);
      if (file) {
        if (uploads.size>=2) throw new Failure('COMMAND_BUSY',429);
        uploads.add(request);
      }
    }},async(request,reply)=>{
      const {bridge,row,session}=await access(request,true);
      const {operationId,file,source,confirm}=input({schema:selection,value:request.query});
      const bytes=Buffer.isBuffer(request.body)?request.body:undefined;
      if (file && !bytes?.length) throw new Failure('BAD_INPUT',400);
      const checksum=bytes?createHash('sha256').update(bytes).digest('hex'):undefined;
      const query=new URLSearchParams({source,confirm});
      if (file) query.set('file',file);
      const value=await runtime.ops.run({id:operationId,actor:session.account.id,resource:row.id,action:'device.firmware.update',correlation:request.id,
        input:{source,file,checksum},serialized:true,execute:async()=>{
          const payload=bytes ? bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer : undefined;
          const response=await bridge.api({path:'/cameras/'+row.routeId+'/firmware',search:'?'+query,stableId:row.remote_id,
            method:'POST',data:payload,correlation:request.id,signal:AbortSignal.timeout(270_000)});
          const body=record(await jsonResponse({response}).catch(()=>({})));
          const ref=typeof body.correlation_id==='string' && correlationPattern.test(body.correlation_id)?body.correlation_id:undefined;
          if(response.status===202 && body.outcome==='acknowledged') return {outcome:'unverified',reason:'FIRMWARE_ACCEPTED',bridgeCorrelationId:ref};
          const reason=typeof body.errorKey==='string' && Object.hasOwn(reasons,body.errorKey)?reasons[body.errorKey as keyof typeof reasons]:undefined;
          return reason?{outcome:'rejected',reason,bridgeCorrelationId:ref}:{outcome:'unknown',reason:'OUTCOME_UNKNOWN',bridgeCorrelationId:ref};
        }});
      return sendOutcome({reply,value});
    });
  });
}
