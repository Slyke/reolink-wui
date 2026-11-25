import { accumulateChange, type SampleWindow } from '../../shared/hotspots.js';
import { t, url } from './api.js';

export const width=320,height=180;
export type HeatMap={sum:Float32Array;picture:ImageData;pairs:number;clips:number;missed:number};

function waitForFrame(video:HTMLVideoElement, event:'loadeddata'|'seeked', signal:AbortSignal, start:()=>void) {
  return new Promise<void>((resolve,reject)=>{
    signal.throwIfAborted();
    const clean=()=>{clearTimeout(timer);video.removeEventListener(event,ready);video.removeEventListener('error',fail);signal.removeEventListener('abort',abort);};
    const ready=()=>{clean();resolve();};
    const fail=()=>{clean();reject(new Error(t('hotspot-video-failed')));};
    const abort=()=>{clean();reject(signal.reason);};
    const timer=setTimeout(fail,event==='loadeddata'?120000:15000);
    video.addEventListener(event,ready);video.addEventListener('error',fail);signal.addEventListener('abort',abort,{once:true});
    try {start();}catch(err){clean();reject(err);}
  });
}

export async function measureWindows(base:string,windows:SampleWindow[],signal:AbortSignal,progress:()=>void):Promise<HeatMap|undefined>{
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  if(!context)throw new Error(t('hotspot-video-failed'));
  context.imageSmoothingQuality='high';
  const video=document.createElement('video');
  video.playsInline=true;video.muted=true;video.preload='auto';
  const sums=new Float32Array(width*height), used=new Set<string>();
  let current='',picture:ImageData|undefined,pairs=0,missed=0;
  try{
    for(const window of windows){
      signal.throwIfAborted();
      try{
        if(current!==window.recording.id){
          current='';
          await waitForFrame(video,'loadeddata',signal,()=>{video.src=url(base+'/recordings/'+window.recording.id+'/video');video.load();});
          current=window.recording.id;
        }
        let previous:ImageData|undefined;
        for(const ms of window.offsets){
          const second=ms/1000;
          if(!Number.isFinite(video.duration)||second>=video.duration)break;
          if(Math.abs(video.currentTime-second)>.001) await waitForFrame(video,'seeked',signal,()=>{video.currentTime=second;});
          context.drawImage(video,0,0,width,height);
          const frame=context.getImageData(0,0,width,height);
          if(previous){accumulateChange(previous.data,frame.data,sums);pairs++;used.add(current);picture??=previous;}
          previous=frame;
        }
      }catch(err){signal.throwIfAborted();missed++;if(missed===windows.length)throw err;}
      progress();
    }
    return picture?{sum:sums,picture,pairs,clips:used.size,missed}:undefined;
  }finally{video.pause();video.removeAttribute('src');video.load();}
}
