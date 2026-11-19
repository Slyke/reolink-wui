import type { RecordingMetadata } from '../../shared/recordings.js';

// Read the MP4 sample table once. Range reads also work when the index follows the video.
export async function recordingFrameTimes(path: string, signal: AbortSignal): Promise<number[]> {
  const { createFile, MP4BoxBuffer } = await import('mp4box');
  const file = createFile(false);
  let times: number[] | undefined;
  file.onError = () => { throw new Error('Invalid recording index'); };
  file.onReady = movie => {
    const track = movie.videoTracks[0];
    if (!track || !track.nb_samples || !track.timescale) throw new Error('Missing video samples');
    const samples = file.getTrackSamplesInfo(track.id).map(sample => sample.cts).sort((a,b) => a-b);
    const edits = track.edits ?? [];
    if (!edits.length) {
      times = samples.map(value => value / track.timescale);
      return;
    }
    let elapsed = 0;
    times = [];
    for (const edit of edits) {
      const duration = edit.segment_duration / movie.timescale;
      if (edit.media_time >= 0) {
        if (edit.media_rate_integer !== 1 || edit.media_rate_fraction !== 0) throw new Error('Unsupported edit rate');
        for (const value of samples) {
          const relative = (value - edit.media_time) / track.timescale;
          if (relative >= 0 && (relative < duration || !duration)) times.push(elapsed + relative);
        }
      }
      elapsed += duration;
    }
  };
  // Bridge recordings use faststart. Normally one small request contains the entire index.
  let offset = 0;
  for (let count = 0; count < 128; count++) {
    const chunk = 128 * 1024;
    const response = await fetch(path, { headers: { range: 'bytes=' + offset + '-' + (offset + chunk - 1) }, signal });
    const length = Number(response.headers.get('content-length'));
    if (![200,206].includes(response.status) || !length || length > chunk || (response.status === 200 && offset !== 0)) {
      await response.body?.cancel();
      break;
    }
    const buffer = await response.arrayBuffer();
    const next = file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, offset));
    if (times?.length) return times;
    if (!Number.isSafeInteger(next) || next <= offset || !buffer.byteLength) break;
    offset = next;
  }
  throw new Error('Video frame index unavailable');
}

// Last item at or before the requested presentation time, also for variable frame rates.
export function indexAt<T>(items: readonly T[], time: number, at: (item: T) => number) {
  let low = 0, high = items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (at(items[middle]) <= time + 0.000001) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
export const frameIndex = (times: readonly number[], seconds: number) => indexAt(times, seconds, time => time);

export function frameDetails(index: number, seconds: number, metadata?: RecordingMetadata) {
  const offsetMs = Math.round(seconds * 1_000_000) / 1000;
  const samples = metadata?.frames ?? [];
  const sample = samples[indexAt(samples, offsetMs, item => item.offsetMs)];
  const observed = sample && offsetMs - sample.offsetMs <= 1000 ? sample : undefined;
  return { frame: index < 0 ? null : index + 1, offsetMs, sampleOffsetMs: observed?.offsetMs ?? null, objects: observed?.objects ?? null };
}

export function recordingJson(times: number[], metadata: RecordingMetadata | undefined, context: Record<string,unknown>) {
  const parts: BlobPart[] = [JSON.stringify({ ...context, frameCount: times.length,
    detectionMetadata: metadata ? metadata.truncated ? 'truncated' : 'available' : 'unavailable' }).slice(0,-1) + ',"frames":[\n'];
  for (let start = 0; start < times.length; start += 256) {
    const batch = times.slice(start,start + 256).map((time,i) => JSON.stringify(frameDetails(start + i,time,metadata)));
    parts.push((start ? ',\n' : '') + batch.join(',\n'));
  }
  parts.push('\n],"detectionSamples":');
  if (metadata) {
    parts.push('[');
    for (let start = 0; start < metadata.frames.length; start += 256) {
      parts.push((start ? ',\n' : '') + metadata.frames.slice(start,start+256).map(sample => JSON.stringify(sample)).join(',\n'));
    }
    parts.push(']');
  } else parts.push('null');
  parts.push('}');
  return new Blob(parts, { type: 'application/json' });
}
