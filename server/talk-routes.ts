import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { talkCapability, talkFormat } from '../shared/talk.js';
import { Failure } from './errors.js';
import { jsonResponse } from './net.js';
import { input, uuid, type Runtime } from './runtime.js';

const chunk = z.strictObject({ sequence: z.int().min(0).max(0xffffffff), pcm: z.base64().min(4).max(24_000) });

// Two users choosing the same public session ID must still own different bridge sessions.
function speakerId(secret: string, session: string, camera: string, publicId: string) {
  const bytes = createHmac('sha256',secret).update(JSON.stringify(['talk',session,camera,publicId])).digest();
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex',0,16);
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
async function upstreamError(response: Response): Promise<never> {
  const result = await jsonResponse({response}) as {errorKey?:string} | null;
  switch(result?.errorKey) {
    case 'API_CAMERA_IDENTITY_CHANGED': throw new Failure('CAMERA_UNKNOWN',409);
    case 'API_TALK_UNSUPPORTED': throw new Failure('UNSUPPORTED',422);
    case 'API_TALK_EXPIRED': throw new Failure('TALK_EXPIRED',404);
    case 'API_TALK_INVALID': throw new Failure('BAD_INPUT',400);
    case 'API_TALK_BUSY': throw new Failure('TALK_BUSY',response.status===429?429:409);
    case 'API_READ_BUSY': throw new Failure('COMMAND_BUSY',503);
    default: throw new Failure('TALK_FAILED',502);
  }
}

export function talkRoutes({api,path,runtime}:{api:FastifyInstance;path:string;runtime:Runtime}) {
  const route = path+'/cameras/:id/talk';
  api.get<{Params:{id:string}}>(route,async request=>{
    const {bridge,row}=await runtime.camera({request,id:request.params.id,permission:'audio.talk'});
    if(!bridge.has('talk') || !bridge.hasDisplay(row.routeId)) return {available:false};
    const response=await bridge.api({path:'/cameras/'+row.routeId+'/talk',stableId:row.remote_id,correlation:request.id});
    if(!response.ok) return upstreamError(response);
    const result=talkCapability.safeParse(await jsonResponse({response}));
    if(!result.success) throw new Failure('TALK_FAILED',502);
    return result.data;
  });
  api.route<{Params:{id:string;session:string}}>({
    method:['POST','PUT','DELETE'],url:route+'/:session',handler:async(request,reply)=>{
      const {bridge,row,session}=await runtime.camera({request,id:request.params.id,permission:'audio.talk',mutate:true});
      if(!bridge.has('talk') || !bridge.hasDisplay(row.routeId) || !bridge.config.http) throw new Failure('UNSUPPORTED',422);
      const publicId=input({schema:uuid,value:request.params.session});
      const id=speakerId(bridge.config.http.token,session.token,row.id,publicId);
      const method=request.method;
      const data=method==='PUT'?input({schema:chunk,value:request.body}):undefined;
      const response=await bridge.api({path:'/cameras/'+row.routeId+'/talk/'+id,stableId:row.remote_id,correlation:request.id,method,data,
        signal:AbortSignal.timeout(method==='PUT'?4500:18_000)});
      if(!response.ok) return upstreamError(response);
      if(method==='POST'){
        const format=talkFormat.safeParse(await jsonResponse({response}));
        if(!format.success) throw new Failure('TALK_FAILED',502);
        return format.data;
      }
      await response.body?.cancel();
      return reply.code(204).send();
    }
  });
}
