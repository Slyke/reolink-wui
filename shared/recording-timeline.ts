import { recordingTime, type RecordingGroup } from './recording-groups.js';
import type { TimelinePhoto } from './recordings.js';

type Video = {item:RecordingGroup; start:number; end:number};
type Photo = {photo:TimelinePhoto; start:number};
export type TimelineCapture = {item:RecordingGroup; time:number; offsetMs:number} | {photo:TimelinePhoto; time:number};

function after<T extends {start:number}>(items: T[], time: number) {
  let low = 0, high = items.length;
  while (low < high) {
    const middle = Math.floor((low+high)/2);
    if (items[middle].start <= time) low = middle+1;
    else high = middle;
  }
  return low;
}

// A nearest-photo lookup also proves that the same photo is closest between the
// requested second and its capture time. A return drag can reuse that interval.
export class ScannedPhotoTimes {
  private ranges: {start:number; from:number; to:number; photo:TimelinePhoto}[] = [];

  remember(second:number, capturedSecond:number, photo:TimelinePhoto) {
    const i = after(this.ranges,capturedSecond);
    const previous = this.ranges[i-1];
    const from = Math.min(second,capturedSecond), to = Math.max(second,capturedSecond);
    if (previous?.start === capturedSecond) {
      previous.from = Math.min(previous.from,from);
      previous.to = Math.max(previous.to,to);
    } else {
      this.ranges.splice(i,0,{start:capturedSecond,from,to,photo});
    }
  }

  lookup(second:number, radius:number):TimelinePhoto | null | undefined {
    const i = after(this.ranges,second);
    for (const range of [this.ranges[i-1],this.ranges[i]]) {
      if (range && range.from <= second && second <= range.to) {
        return Math.abs(range.start-second) <= radius ? range.photo : null;
      }
    }
  }
  clear() { this.ranges.length = 0; }
}

export function timelineIndex(recordings: RecordingGroup[], photos: TimelinePhoto[]) {
  const clips = recordings.map(item => ({item,start:recordingTime(item.start),end:recordingTime(item.end)}))
    .sort((a,b) => a.start-b.start);
  const stills = photos.map(photo => ({photo,start:recordingTime(photo.capturedAt)})).sort((a,b) => a.start-b.start);
  // A long clip can outlast several later-starting clips.
  const longest: Video[] = [];
  for (const clip of clips) {
    const last = longest.at(-1);
    longest.push(last && last.end > clip.end ? last : clip);
  }
  const frame = (video: Video, time: number): TimelineCapture => {
    const offsetMs = Math.max(0,Math.floor((Math.min(time,video.end-1)-video.start)/1000)*1000);
    return {item:video.item,time:video.start+offsetMs,offsetMs};
  };
  const closest = (time: number): TimelineCapture | undefined => {
    const v = after(clips,time), p = after(stills,time);
    const recent = clips[v-1], previous = longest[v-1], next = clips[v];
    if (recent && time < recent.end) return frame(recent,time);
    if (previous && time < previous.end) return frame(previous,time);
    let best: TimelineCapture | undefined = previous ? frame(previous,time) : undefined;
    if (next && (!best || next.start-time < time-best.time)) best = frame(next,next.start);
    for (const candidate of [stills[p-1],stills[p]]) {
      if (candidate && (!best || Math.abs(candidate.start-time) < Math.abs(best.time-time))) {
        best = {photo:candidate.photo,time:candidate.start};
      }
    }
    return best;
  };
  return {
    first: Math.min(clips[0]?.start ?? Infinity,stills[0]?.start ?? Infinity),
    last: Math.max(longest.at(-1)?.end ?? -Infinity,(stills.at(-1)?.start ?? -Infinity)+1),
    closest
  };
}
