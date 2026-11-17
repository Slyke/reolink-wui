
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { defaultPreviewIntervalMs } from '../shared/playback.js';
import type { Bridge } from './bridge.js';
import { available } from './cameras.js';
import type { CameraRef } from './db.js';
import { Failure } from './errors.js';
import { validatePng } from './png.js';
import { responseBytes } from './net.js';

const multipartType = 'multipart/x-mixed-replace; boundary=wui';
const frameBytes = 2_000_000;
const cannotPlay = () => new Failure('MEDIA_UNAVAILABLE', 502);

export const rtspProxyUrl = z.string().max(2048).url().transform(value => new URL(value)).refine(url =>
  url.protocol === 'rtsp:' && !!url.hostname && !url.username && !url.password && !url.hash && !url.search
  && !/%|\\/.test(url.host)
);

type Profile = { bridge: Bridge; row: CameraRef };
type Frame = { bytes: Buffer; type: 'image/jpeg' | 'image/png' };
type PreviewResult = { frame?: Frame; etag?: string; capturedAt?: string };
type Preview = { source: string | null; finishedAt?: number; frame: Promise<Frame> };

export const playbackStreams = ({ bridge, row }: Profile) => row.rtsp_proxy ? ['main'] : bridge.streams(row.remote_id);

const readJpeg = async ({ stream }: { stream: Readable }) => {
  let header = Buffer.alloc(0);
  let length: number | undefined;
  let remaining = 0;
  const chunks: Buffer[] = [];
  for await (const raw of stream) {
    let data: Buffer = raw;
    if (length === undefined) {
      header = Buffer.concat([header, data]);
      const split = header.indexOf('\r\n\r\n');
      if (split === -1 && header.length <= 1024) continue;
      if (split < 0 || split > 1024 || !header.subarray(0, 7).equals(Buffer.from('--wui\r\n'))) throw cannotPlay();
      const fields = header.toString('ascii', 7, split);
      length = Number(/^content-length:\s*(\d+)\s*$/im.exec(fields)?.[1]);
      if (!Number.isSafeInteger(length) || length < 4 || length > frameBytes || !/^content-type:\s*image\/jpeg\s*$/im.test(fields)) {
        throw cannotPlay();
      }
      remaining = length;
      data = header.subarray(split + 4);
    }
    const frame = data.subarray(0, remaining);
    chunks.push(frame);
    remaining -= frame.length;
    if (remaining === 0) {
      const bytes = Buffer.concat(chunks, length);
      if (bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw cannotPlay();
      return bytes;
    }
  }
  throw cannotPlay();
};

export class Playback {
  private readonly previews = new Map<string, Preview>();
  private pendingPreviews = 0;
  private proxyProcesses = 0;

  async open({ bridge, row, stream, signal, correlation, still = false }: Profile & {
    stream: string; signal: AbortSignal; correlation: string; still?: boolean
  }) {
    if (!playbackStreams({ bridge, row }).includes(stream)) throw new Failure('MEDIA_UNAVAILABLE', 422);
    if (row.rtsp_proxy) {
      return { type: multipartType, stream: await this.restream({ source: row.rtsp_proxy, signal, still }) };
    }
    const upstream = await bridge.app({ path: '/cameras/' + row.remote_id + '/media/' + stream, signal, correlation });
    const type = upstream.headers.get('content-type') ?? '';
    if (!upstream.ok || !upstream.body || type.toLowerCase() !== multipartType) {
      await upstream.body?.cancel().catch(() => {});
      throw cannotPlay();
    }
    return { type, stream: Readable.fromWeb(upstream.body as never, { signal, highWaterMark: 32_768 }) };
  }

  async preview({ bridge, row, correlation, refresh, ifNoneMatch }: Profile & {
    correlation: string; refresh: boolean; ifNoneMatch?: string
  }): Promise<PreviewResult> {
    if (!row.rtsp_proxy && bridge.hasPreview(row.remote_id)) {
      return this.bridgePreview({ bridge, row, correlation, refresh, ifNoneMatch });
    }
    return { frame: await this.localPreview({ bridge, row, correlation, refresh }) };
  }

  private async bridgePreview({ bridge, row, correlation, refresh, ifNoneMatch }: Profile & {
    correlation: string; refresh: boolean; ifNoneMatch?: string
  }): Promise<PreviewResult> {
    const response = await bridge.app({
      path: '/cameras/' + row.remote_id + '/preview', search: refresh ? '?refresh=true' : undefined,
      correlation, ifNoneMatch, signal: AbortSignal.timeout(refresh ? 40_000 : 4_000)
    });
    const etag = response.headers.get('etag') ?? '';
    const timestamp = response.headers.get('x-preview-captured-at') ?? '';
    const capturedAt = timestamp.length <= 40 && Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
    if (/^"[0-9a-f]{64}"$/.test(etag)) {
      if (response.status === 304 && ifNoneMatch) return { etag, capturedAt };
      if (response.ok && response.headers.get('content-type') === 'image/jpeg') {
        const bytes = await responseBytes({ response, limit: 8 * 1024 * 1024 });
        if (bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9) {
          return { frame: { bytes, type: 'image/jpeg' }, etag, capturedAt };
        }
      }
    }
    if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
    throw cannotPlay();
  }

  private localPreview({ bridge, row, correlation, refresh }: Profile & { correlation: string; refresh: boolean }) {
    const previous = this.previews.get(row.id);
    const cacheMs = Math.min(row.preview_interval_ms, defaultPreviewIntervalMs);
    if (previous?.source === row.rtsp_proxy
      && (previous.finishedAt === undefined || (!refresh && performance.now() - previous.finishedAt < cacheMs))) return previous.frame;
    if (this.pendingPreviews >= 8) throw new Failure('MEDIA_LIMIT', 429);
    if (this.previews.size >= 64) {
      const oldest = [...this.previews].find(([, entry]) => entry.finishedAt !== undefined);
      if (oldest) this.previews.delete(oldest[0]);
    }
    this.previews.delete(row.id);
    this.pendingPreviews++;
    const next: Preview = {
      source: row.rtsp_proxy,
      frame: this.capture({ bridge, row, correlation }).finally(() => {
        this.pendingPreviews--;
        next.finishedAt = performance.now();
      })
    };
    this.previews.set(row.id, next);
    return next.frame;
  }

  private async capture({ bridge, row, correlation }: Profile & { correlation: string }): Promise<Frame> {
    const streams = playbackStreams({ bridge, row });
    if (streams.length) {
      try {
        const stream = streams.includes('sub') ? 'sub' : streams[0];
        const connection = await this.open({ bridge, row, stream, signal: AbortSignal.timeout(12_000), correlation, still: true });
        try { return { bytes: await readJpeg({ stream: connection.stream }), type: 'image/jpeg' }; }
        finally { connection.stream.destroy(); }
      } catch (error) {
        if (row.rtsp_proxy || !bridge.canCapture(row.remote_id)) throw error;
      }
    }
    if (!bridge.canCapture(row.remote_id)) throw new Failure('MEDIA_UNAVAILABLE', 422);
    if (available({ bridge, remote: row.remote_id }).online === false) throw new Failure('CAMERA_OFFLINE', 409);
    const result = await bridge.command({ camera: row.remote_id, id: randomUUID(), command: { setting: 'snapshot' }, capture: true, correlation });
    if (result.ok !== true) throw cannotPlay();
    return { bytes: validatePng({ result: result.result }), type: 'image/png' };
  }

  private async restream({ source, signal, still }: { source: string; signal: AbortSignal; still: boolean }) {
    if (signal.aborted) throw cannotPlay();
    if (this.proxyProcesses >= 8) throw new Failure('MEDIA_LIMIT', 429);
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1',
      '-protocol_whitelist', 'rtsp,tcp', '-rtsp_transport', 'tcp', '-allowed_media_types', 'video',
      '-probesize', '500000', '-analyzeduration', '1500000', '-f', 'rtsp', '-i', source,
      '-map', '0:v:0', '-an', '-vf', still ? 'scale=w=min(iw\\,640):h=-2' : 'fps=8,scale=w=min(iw\\,1280):h=-2',
      ...(still ? ['-frames:v', '1'] : []),
      '-threads', '1', '-c:v', 'mjpeg', '-q:v', '6', '-f', 'mpjpeg', '-boundary_tag', 'wui', 'pipe:1'
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    this.proxyProcesses++;
    const stop = () => { child.kill('SIGKILL'); };
    const deadline = setTimeout(stop, 12_000);
    signal.addEventListener('abort', stop, { once: true });
    child.stdout.once('close', stop);
    child.once('error', () => child.stdout.destroy());
    child.once('close', () => {
      clearTimeout(deadline);
      signal.removeEventListener('abort', stop);
      this.proxyProcesses--;
    });
    await new Promise<void>((resolve, reject) => {
      const settle = () => {
        child.stdout.off('readable', ready);
        child.stdout.off('close', failed);
        clearTimeout(deadline);
      };
      const ready = () => {
        if (child.stdout.readableLength === 0) return;
        settle();
        resolve();
      };
      const failed = () => { settle(); reject(cannotPlay()); };
      child.stdout.on('readable', ready);
      child.stdout.once('close', failed);
    });
    return child.stdout;
  }
}
