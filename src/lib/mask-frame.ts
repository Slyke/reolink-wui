import { fetchPreview } from './api.js';
import type { Camera } from './models.js';

export async function maskFrame({base,camera,cache,fresh,signal}:{
  base:string;camera:Camera;cache:Map<string,Blob>;fresh:boolean;signal:AbortSignal;
}):Promise<Blob>{
  const cached=cache.get(camera.id);
  if(cached && !fresh)return cached;
  const read=(capture:boolean)=>fetchPreview({path:base+'/preview'+(capture?'?refresh=true':''),signal});
  const response=await read(fresh).catch(reason=>{
    if(fresh || !camera.capabilities.bridgePreview || signal.aborted)throw reason;
    return read(true);
  });
  if(!response.image)throw Error();
  signal.throwIfAborted();
  cache.set(camera.id,response.image);
  return response.image;
}
