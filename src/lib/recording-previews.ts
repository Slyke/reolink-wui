import { api, url } from './api.js';
import type { TimelinePhoto } from '../../shared/recordings.js';
import { recordingTime, type RecordingGroup } from '../../shared/recording-groups.js';
import { RecordingPreviewCache, recordingPreviewLifetime, type RecordingFrame } from '../../shared/recording-preview-cache.js';

type Frame = RecordingFrame<Blob>;
type Job = { result: Promise<Frame>; controller: AbortController; readers: number };

// One cache per camera on the signed-in Recordings page. Cards, table and timeline share it.
export class RecordingPreviews extends RecordingPreviewCache<Blob> {
  private jobs = new Map<string, Job>();
  private photoTimes = new Map<string, {photo:TimelinePhoto|null; expires:number}>();

  constructor(private camera: string, private date: string) { super(); }

  private async load(recording: string, offset: number, signal: AbortSignal, background: boolean) {
    const resource = recording.startsWith('photo/')
      ? '/time-lapse/photos/' + recording.slice(6) + '/preview?date=' + this.date
      : '/recordings/' + recording + '/preview?offsetMs=' + offset;
    const path = url('/api/v1/cameras/' + this.camera + resource);
    const response = await fetch(path, { signal, priority: background ? 'low' : 'auto' });
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/jpeg') {
      await response.body?.cancel();
      throw new Error('Recording preview unavailable', { cause: response.status });
    }
    const jpeg = await response.blob();
    signal.throwIfAborted();
    const selected = response.headers.get('x-preview-offset-ms');
    const frame = { jpeg, offsetMs: selected !== null && /^\d+$/.test(selected) && Number(selected) <= offset ? Number(selected) : offset };
    this.store(recording, offset, frame, jpeg.size);
    return frame;
  }

  async read(recording: string, offset: number, signal: AbortSignal, background = false) {
    signal.throwIfAborted();
    const hit = this.exact(recording, offset);
    if (hit) return hit;
    const key = recording + '/' + offset;
    let job = this.jobs.get(key);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController();
      const result = this.load(recording, offset, AbortSignal.any([controller.signal, AbortSignal.timeout(recording.startsWith('photo/') ? 140_000 : 45_000)]), background);
      job = { controller, result, readers: 0 };
      this.jobs.set(key, job);
    }
    const shared = job;
    shared.readers++;
    let attached = true;
    const release = () => {
      if (!attached) return;
      attached = false;
      if (--shared.readers === 0) {
        shared.controller.abort();
        if (this.jobs.get(key) === shared) this.jobs.delete(key);
      }
    };
    signal.addEventListener('abort', release, { once: true });
    try {
      const frame = await shared.result;
      signal.throwIfAborted();
      return frame;
    } finally { signal.removeEventListener('abort', release); release(); }
  }

  async nearestPhoto(second:number,radius:number,signal:AbortSignal) {
    const key = second+'/'+radius;
    const hit = this.photoTimes.get(key);
    if (hit && hit.expires > Date.now()) return hit.photo;
    const query = new URLSearchParams({date:this.date,second:String(second),radius:String(radius)});
    const {photo} = await api<{photo:TimelinePhoto|null}>({path:'/api/v1/cameras/'+this.camera+'/time-lapse/photos/nearest?'+query,signal});
    signal.throwIfAborted();
    if (this.photoTimes.size >= 1024) this.photoTimes.delete(this.photoTimes.keys().next().value!);
    this.photoTimes.set(key,{photo,expires:Date.now()+recordingPreviewLifetime});
    return photo;
  }

  async warm(recordings: RecordingGroup[], start: number, end: number, width: number, signal: AbortSignal) {
    const until = Date.now() + recordingPreviewLifetime;
    const midnight = recordingTime(this.date + 'T00:00:00');
    const failedClips = new Set<string>();
    for (const [recording, offset] of timelineFrames(recordings, start, end, width, midnight)) {
      if (signal.aborted || Date.now() >= until) return;
      if (failedClips.has(recording) || this.exact(recording, offset)) continue;
      try { await this.read(recording, offset, signal, true); }
      catch (error) {
        if (signal.aborted || !(error instanceof Error) || ![404, 502].includes(Number(error.cause))) return;
        failedClips.add(recording);
      }
      if (this.full) return;
    }
  }

  close() {
    for (const job of this.jobs.values()) job.controller.abort();
    this.jobs.clear();
    this.photoTimes.clear();
    this.clear();
  }
}

// Cover the whole rail first, including short clips narrower than one pixel. Then fill in individual seconds.
function* timelineFrames(groups: RecordingGroup[], start: number, end: number, width: number, midnight: number): Generator<[string, number]> {
  const clips = groups.map(group => group.variants[0]);
  for (const clip of clips) yield [clip.id, 0];
  const perPixel = (end - start) / Math.max(1, Math.ceil(width));
  for (const clip of clips) {
    const from = recordingTime(clip.start), to = recordingTime(clip.end);
    let last = 0;
    for (let x = Math.max(0, Math.ceil((from - start) / perPixel)); x < width && start + x * perPixel < to; x++) {
      const offset = Math.max(0, Math.floor(Math.min(start + x * perPixel - from, to - from - 1000) / 1000) * 1000);
      if (offset !== last) { yield [clip.id, offset]; last = offset; }
    }
  }
  for (const clip of clips) {
    const from = recordingTime(clip.start);
    const duration = Math.min(recordingTime(clip.end), midnight + 86_400_000) - from;
    for (let offset = Math.max(1000, midnight - from); offset <= duration - 1000; offset += 1000) yield [clip.id, offset];
  }
}
