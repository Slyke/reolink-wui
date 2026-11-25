import { recordingTime, recordingVariant, type RecordingGroup } from './recording-groups.js';
import type { Recording } from './recordings.js';

const day = 86_400_000;
export const stepMs = 500;
const maxWindows = 6, windowMs = 4000;
export type Period = {from:number; to:number};
export type SampleWindow = {recording:Recording; offsets:number[]};

// Long spans sample dates across the entire selection, including both endpoints.
export function sampleDates({from,to}:Period) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to<=from) return [];
  const first=Math.floor(from/day),count=Math.floor((to-1)/day)-first+1;
  const dates=[];
  for(let i=0;i<Math.min(count,maxWindows);i++) {
    const offset=count<=maxWindows?i:Math.round(i*(count-1)/(maxWindows-1));
    dates.push(new Date((first+offset)*day).toISOString().slice(0,10));
  }
  return dates;
}

export function sampleWindows(groups:RecordingGroup[], {from,to}:Period):SampleWindow[] {
  const clips=groups.map(g=>recordingVariant({group:g,stream:'sub'})).sort((a,b)=>a.start.localeCompare(b.start)||b.end.localeCompare(a.end));
  const spans:{recording:Recording;start:number;end:number;axis:number}[]=[];
  let covered=from,total=0;
  for(const clip of clips){
    const start=Math.max(covered,recordingTime(clip.start)),end=Math.min(to,recordingTime(clip.end));
    if(end-start<=stepMs)continue;
    spans.push({recording:clip,start,end,axis:total}); total+=end-start;covered=end;
  }
  if(!total)return [];
  const n=Math.min(maxWindows,Math.ceil(total/windowMs));
  const results:SampleWindow[]=[];
  for(let i=0;i<n;i++){
    const lower=Math.floor(i*total/n), upper=Math.floor((i+1)*total/n);
    const center=(lower+upper)/2;
    const span=spans.find(s=>center<s.axis+s.end-s.start)!;
    const start=Math.max(span.start,span.start+lower-span.axis);
    const end=Math.min(span.end,span.start+upper-span.axis);
    const length=Math.min(windowMs,end-start-1);
    const first=Math.round((start+end-length-1)/2);
    const offsets=[];
    for(let delta=0;delta<=length;delta+=stepMs) offsets.push(first+delta-recordingTime(span.recording.start));
    if(offsets.length>1)results.push({recording:span.recording,offsets});
  }
  return results;
}

export function accumulateChange(before:Uint8ClampedArray,after:Uint8ClampedArray,sum:Float32Array){
  for(let i=0,p=0;i<sum.length;i++,p+=4){
    // BT.709 luma, in 8-bit brightness levels.
    sum[i]+=Math.abs(.2126*(after[p]-before[p])+.7152*(after[p+1]-before[p+1])+.0722*(after[p+2]-before[p+2]));
  }
}
