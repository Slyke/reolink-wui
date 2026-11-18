import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Bridge } from './bridge.js';
import type { Runtime } from './runtime.js';
import { input } from './runtime.js';
import { Failure } from './errors.js';
import { jsonResponse } from './net.js';
import { audit } from './db.js';
import { recordingDate, recordingId, recordingsResponse, recordingStream, storageResponse } from '../shared/recordings.js';

const object = z.strictObject;
const bridgeRead = async ({ bridge, path, search, correlation, schema }: {
  bridge: Bridge; path: string; search?: string; correlation: string; schema: z.ZodType
}) => {
  const response = await bridge.api({ path, search, correlation, signal: AbortSignal.timeout(48_000) });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 422) throw new Failure('UNSUPPORTED', 422);
    throw new Failure('BRIDGE_UNAVAILABLE', 502);
  }
  const parsed = schema.safeParse(await jsonResponse({ response }));
  if (!parsed.success) throw new Failure('BRIDGE_UNAVAILABLE', 502);
  return parsed.data;
};

export const recordingRoutes = ({ api, path, runtime }: { api: FastifyInstance; path: string; runtime: Runtime }) => {
  const root = path + '/cameras/:id';
  const camera = async (request: Parameters<Runtime['camera']>[0]['request'], id: string) => {
    const result = await runtime.camera({ request, id, permission: 'recordings.view' });
    if (!result.bridge.hasStorage(result.row.remote_id)) throw new Failure('UNSUPPORTED', 422);
    return result;
  };
  api.get<{ Params: { id: string } }>(root + '/storage', async request => {
    const { bridge, row } = await camera(request, request.params.id);
    return bridgeRead({
      bridge, path: '/cameras/' + row.remote_id + '/storage', correlation: request.id, schema: storageResponse
    });
  });
  api.get<{ Params: { id: string } }>(root + '/recordings', async request => {
    const query = input({ schema: object({ date: recordingDate, stream: recordingStream.default('sub') }), value: request.query });
    const { bridge, row } = await camera(request, request.params.id);
    return bridgeRead({
      bridge, path: '/cameras/' + row.remote_id + '/recordings', correlation: request.id,
      search: '?' + new URLSearchParams(query), schema: recordingsResponse
    });
  });
  api.get<{ Params: { id: string; recording: string } }>(root + '/recordings/:recording/video', async (request, reply) => {
    const id = input({ schema: recordingId, value: request.params.recording });
    const { bridge, row, session } = await camera(request, request.params.id);
    if (!bridge.hasRecordings(row.remote_id)) throw new Failure('UNSUPPORTED', 422);
    const range = request.headers.range;
    if (range && !/^bytes=(\d+-\d*|-\d+)$/.test(range)) throw new Failure('BAD_INPUT', 400);
    const controller = new AbortController();
    let checking: ReturnType<typeof setTimeout> | undefined;
    let stream: Readable | undefined;
    const stop = () => {
      clearTimeout(checking);
      controller.abort();
      stream?.destroy();
    };
    const validate = async () => {
      const active = await camera(request, row.id);
      if (active.session.token !== session.token || !active.bridge.hasRecordings(active.row.remote_id)) return stop();
      if (!controller.signal.aborted) checking = setTimeout(() => void validate().catch(stop), 700);
    };
    checking = setTimeout(() => void validate().catch(stop), 700);
    reply.raw.once('close', stop);
    try {
      const response = await bridge.api({
        path: '/cameras/' + row.remote_id + '/recordings/' + id + '/video',
        range, correlation: request.id, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(125_000)])
      });
      if (![200, 206, 416].includes(response.status)) {
        await response.body?.cancel();
        throw new Failure('MEDIA_UNAVAILABLE', response.status === 404 ? 404 : 502);
      }
      const contentRange = response.headers.get('content-range');
      if (contentRange && /^bytes (?:(\d+-\d+)|\*)\/\d+$/.test(contentRange)) reply.header('content-range', contentRange);
      if (response.status === 416) {
        await response.body?.cancel();
        stop();
        return reply.code(416).send();
      }
      const length = response.headers.get('content-length');
      if (!response.body || response.headers.get('content-type') !== 'video/mp4' || !length || !/^\d+$/.test(length)
        || Number(length) > 768 * 1024 * 1024) {
        await response.body?.cancel();
        throw new Failure('MEDIA_UNAVAILABLE', 502);
      }
      const active = await camera(request, row.id);
      if (active.session.token !== session.token) stop();
      if (controller.signal.aborted) throw new Failure('ACCESS_DENIED', 403);
      await audit({
        query: runtime.sql.query, actor: session.account.id, resource: row.id,
        action: 'recording-playback', outcome: 'confirmed', correlation: request.id
      });
      stream = Readable.fromWeb(response.body as never, { signal: controller.signal, highWaterMark: 64 * 1024 });
      stream.once('close', stop);
      return reply.code(response.status).type('video/mp4').header('accept-ranges', 'bytes')
        .header('content-length', length).header('x-accel-buffering', 'no').send(stream);
    } catch (error) {
      stop();
      throw error;
    }
  });
};
