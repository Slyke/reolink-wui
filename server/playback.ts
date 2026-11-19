import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import type { Bridge } from './bridge.js';
import type { CameraRef } from './db.js';
import { Failure } from './errors.js';
import { responseBytes } from './net.js';

const multipartType = 'multipart/x-mixed-replace; boundary=wui';
const frameBytes = 2_000_000;
const cannotPlay = () => new Failure('MEDIA_UNAVAILABLE', 502);

export const rtspProxyUrl = z.string().max(2048).url().transform(value => new URL(value)).refine(url =>
  url.protocol === 'rtsp:' && !!url.hostname && !url.username && !url.password && !url.hash && !url.search
  && !/%|\\/.test(url.host)
);

type Profile = { bridge: Bridge; row: CameraRef & { routeId: string } };
type MediaProfile = Profile & { stream: string; correlation: string };
type MediaSource = { input: Readable; boundary: string; close: () => void | Promise<void> };
type SharedStream = {
  source: string | null;
  controller: AbortController;
  viewers: Set<PassThrough>;
  latest?: Buffer;
  done: Promise<void>;
};
type PreviewResult = { frame?: Buffer; etag?: string; capturedAt?: string };

export const playbackStreams = ({ bridge, row }: Profile) => row.rtsp_proxy ? ['main'] : bridge.streams(row.routeId);

const isJpeg = (bytes: Buffer) =>
  bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9;

export const bridgePreview = async ({ bridge, row, correlation, refresh, ifNoneMatch }: Profile & {
  correlation: string; refresh: boolean; ifNoneMatch?: string
}): Promise<PreviewResult> => {
  if (!bridge.hasPreview(row.routeId)) throw new Failure('MEDIA_UNAVAILABLE', 422);
  const response = await bridge.api({
    stableId: row.remote_id, path: '/cameras/' + row.routeId + '/preview', search: refresh ? '?refresh=true' : undefined,
    correlation, ifNoneMatch, signal: AbortSignal.timeout(refresh ? 40_000 : 4_000)
  });
  const etag = response.headers.get('etag') ?? '';
  const timestamp = response.headers.get('x-preview-captured-at') ?? '';
  const capturedAt = timestamp.length <= 40 && Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
  if (/^"[0-9a-f]{64}"$/.test(etag)) {
    if (response.status === 304 && ifNoneMatch) return { etag, capturedAt };
    if (response.ok && response.headers.get('content-type') === 'image/jpeg') {
      const frame = await responseBytes({ response, limit: 8 * 1024 * 1024 });
      if (isJpeg(frame)) return { frame, etag, capturedAt };
    }
  }
  if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
  if (response.status === 503) throw new Failure('MEDIA_UNAVAILABLE', 503);
  throw cannotPlay();
};

async function* jpegParts({ input, boundary }: MediaSource): AsyncGenerator<Buffer> {
  const delimiter = '--' + boundary + '\r\n';
  let header: Buffer = Buffer.alloc(0);
  let remaining = 0;
  let length = 0;
  let chunks: Buffer[] = [];
  for await (const raw of input) {
    let data: Buffer = raw;
    while (data.length > 0) {
      if (remaining === 0) {
        const buffer = header.length ? Buffer.concat([header, data]) : data;
        // FFmpeg inserts CRLF between parts and may split the boundary across chunks.
        const start = buffer.subarray(0, 2).equals(Buffer.from('\r\n')) ? 2 : 0;
        const end = buffer.indexOf('\r\n\r\n', start);
        if (end === -1 && buffer.length <= 1024) {
          header = buffer;
          break;
        }
        const fields = buffer.toString('ascii', start, end);
        length = Number(/^content-length:\s*(\d+)\s*$/im.exec(fields)?.[1]);
        if (end < 0 || end > 1024 || !fields.startsWith(delimiter)
          || !/^content-type:\s*image\/jpeg\s*$/im.test(fields)
          || !Number.isSafeInteger(length) || length < 4 || length > frameBytes) throw cannotPlay();
        remaining = length;
        header = Buffer.alloc(0);
        data = buffer.subarray(end + 4);
        if (data.length === 0) break;
      }
      const body = data.subarray(0, remaining);
      chunks.push(body);
      remaining -= body.length;
      data = data.subarray(body.length);
      if (remaining === 0) {
        const jpeg = Buffer.concat(chunks, length);
        if (!isJpeg(jpeg)) throw cannotPlay();
        chunks = [];
        yield Buffer.concat([Buffer.from('--wui\r\nContent-Type: image/jpeg\r\nContent-Length: ' + length + '\r\n\r\n'), jpeg, Buffer.from('\r\n')]);
      }
    }
  }
  if (remaining !== 0) throw cannotPlay();
}

export class Playback {
  private readonly streams = new Map<string, SharedStream>();
  private proxyProcesses = 0;

  async open({ signal, ...profile }: MediaProfile & { signal: AbortSignal }) {
    const { bridge, row, stream } = profile;
    if (!playbackStreams({ bridge, row }).includes(stream)) throw new Failure('MEDIA_UNAVAILABLE', 422);
    const key = row.id + '/' + row.routeId + '/' + stream;
    let active = this.streams.get(key);
    while (active && (active.controller.signal.aborted || active.source !== row.rtsp_proxy)) {
      active.controller.abort();
      await active.done;
      active = this.streams.get(key);
    }
    if (signal.aborted) throw cannotPlay();

    const output = new PassThrough({ highWaterMark: 32_768 });
    const shared: SharedStream = active ?? {
      source: row.rtsp_proxy, controller: new AbortController(), viewers: new Set(), done: Promise.resolve()
    };
    shared.viewers.add(output);
    const detach = () => {
      if (shared.viewers.delete(output) && !shared.viewers.size) shared.controller.abort();
    };
    const close = () => {
      detach();
      // End the downstream HTTP response so reverse proxies release the browser connection.
      if (!output.destroyed && !output.writableEnded) output.end('--wui--\r\n');
    };
    signal.addEventListener('abort', close, { once: true });
    output.once('close', () => {
      signal.removeEventListener('abort', close);
      detach();
    });
    if (shared.latest) output.write(shared.latest);
    if (!active) {
      this.streams.set(key, shared);
      shared.done = this.broadcast({ key, shared, profile });
    }

    try {
      if (output.readableLength === 0) await once(output, 'readable', { signal });
      if (!output.readableLength || signal.aborted) throw cannotPlay();
      return { type: multipartType, stream: output };
    } catch (error) {
      output.destroy();
      throw error instanceof Failure ? error : cannotPlay();
    }
  }

  private async broadcast({ key, shared, profile }: { key: string; shared: SharedStream; profile: MediaProfile }) {
    const { signal } = shared.controller;
    let failure = cannotPlay();
    try {
      while (!signal.aborted) {
        const attempt = new AbortController();
        const abort = () => attempt.abort();
        signal.addEventListener('abort', abort, { once: true });
        let deadline = setTimeout(abort, 25_000);
        let source: MediaSource | undefined;
        let hasFrame = false;
        try {
          source = await this.upstream({ ...profile, signal: attempt.signal });
          for await (const part of jpegParts(source)) {
            hasFrame = true;
            clearTimeout(deadline);
            deadline = setTimeout(abort, 12_000);
            shared.latest = part;
            for (const viewer of shared.viewers) {
              // A slow viewer can skip a frame without holding up the camera or other viewers.
              if (!viewer.destroyed && !viewer.writableNeedDrain) viewer.write(part);
            }
          }
          if (!hasFrame || attempt.signal.aborted) throw cannotPlay();
        } finally {
          clearTimeout(deadline);
          signal.removeEventListener('abort', abort);
          await source?.close();
        }
        // The authenticated bridge relay has a bounded lifetime. Active viewers can
        // continue on the next upstream connection after the previous one has closed.
        if (!signal.aborted) await wait(250, undefined, { signal });
      }
    } catch (error) {
      if (error instanceof Failure) failure = error;
    } finally {
      shared.controller.abort();
      this.streams.delete(key);
      for (const viewer of shared.viewers) {
        if (viewer.destroyed) continue;
        if (shared.latest) viewer.end();
        else viewer.destroy(failure);
      }
      shared.latest = undefined;
    }
  }

  private async upstream({ bridge, row, stream, correlation, signal }: MediaProfile & { signal: AbortSignal }): Promise<MediaSource> {
    if (row.rtsp_proxy) return this.restream({ source: row.rtsp_proxy, signal });
    const response = await bridge.api({ stableId: row.remote_id, path: '/cameras/' + row.routeId + '/media/' + stream, signal, correlation });
    const type = response.headers.get('content-type') ?? '';
    const match = /^multipart\/x-mixed-replace\s*;\s*boundary=(?:"([\w.-]{1,70})"|([\w.-]{1,70}))\s*$/i.exec(type);
    const boundary = match?.[1] ?? match?.[2];
    if (!response.ok || !response.body || !boundary) {
      await response.body?.cancel().catch(() => {});
      throw cannotPlay();
    }
    const input = Readable.fromWeb(response.body as never, { signal, highWaterMark: 32_768 });
    return { input, boundary, close: () => { input.destroy(); } };
  }

  private restream({ source, signal }: { source: string; signal: AbortSignal }): MediaSource {
    if (signal.aborted) throw cannotPlay();
    if (this.proxyProcesses >= 8) throw new Failure('MEDIA_LIMIT', 429);
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1',
      '-protocol_whitelist', 'rtsp,tcp', '-rtsp_transport', 'tcp', '-allowed_media_types', 'video',
      '-probesize', '500000', '-analyzeduration', '1500000', '-f', 'rtsp', '-i', source,
      '-map', '0:v:0', '-an', '-vf', 'fps=8,scale=w=min(iw\\,1280):h=-2',
      '-threads', '1', '-c:v', 'mjpeg', '-q:v', '6', '-f', 'mpjpeg', '-boundary_tag', 'wui', '-flush_packets', '1', 'pipe:1'
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    this.proxyProcesses++;
    const stop = () => { child.kill('SIGKILL'); };
    signal.addEventListener('abort', stop, { once: true });
    child.once('error', () => child.stdout.destroy());
    const closed = new Promise<void>(resolve => child.once('close', () => {
      this.proxyProcesses--;
      signal.removeEventListener('abort', stop);
      resolve();
    }));
    return { input: child.stdout, boundary: 'wui', close: async () => { stop(); child.stdout.destroy(); await closed; } };
  }
}
