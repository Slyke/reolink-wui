import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Bridge } from './bridge.js';
import type { Runtime } from './runtime.js';
import { input } from './runtime.js';
import { Failure } from './errors.js';
import { jsonResponse, responseBytes } from './net.js';
import { audit } from './db.js';
import { correlationPattern } from '../shared/urls.js';
import { record } from './bridge-channels.js';
import { recordingStages, recordingMetadataResponse, recordingDate, recordingId, recordingsResponse, recordingStream, storageResponse } from '../shared/recordings.js';

const object = z.strictObject;
const bridgeRead = async ({ bridge, stableId, path, search, correlation, schema, failureKey }: {
  bridge: Bridge; stableId: string; path: string; search?: string; correlation: string; schema: z.ZodType;
  failureKey: 'STORAGE_READ_FAILED' | 'RECORDING_SEARCH_FAILED'
}) => {
  const response = await bridge.api({ path, stableId, search, correlation, signal: AbortSignal.timeout(48_000) });
  if (!response.ok) {
    const body = record(await jsonResponse({ response, limit: 16_384 }).catch(() => ({})));
    const details = {
      upstreamStatus: response.status,
      bridgeCorrelationId: typeof body.correlation_id === 'string' && correlationPattern.test(body.correlation_id)
        ? body.correlation_id : undefined
    };
    if (response.status === 422 && body.errorKey === 'API_MEDIA_UNSUPPORTED') {
      throw new Failure('UNSUPPORTED', 422, undefined, details);
    }
    // Older bridges use 422 for a failed device read even when recording search is available.
    const status = [503, 504].includes(response.status) ? response.status : 502;
    throw new Failure(failureKey, status, undefined, details);
  }
  const parsed = schema.safeParse(await jsonResponse({ response }).catch(() => undefined));
  if (!parsed.success) throw new Failure(failureKey, 502);
  return parsed.data;
};

const mediaFailure = async ({ response }: { response: Response }) => {
  const body = record(await jsonResponse({ response, limit: 16_384 }).catch(() => ({})));
  const stage = typeof body.stage === 'string' && recordingStages.includes(body.stage as typeof recordingStages[number]) ? body.stage : 'preparation';
  const bridgeCorrelationId = typeof body.correlation_id === 'string' && correlationPattern.test(body.correlation_id) ? body.correlation_id : undefined;
  return new Failure('MEDIA_UNAVAILABLE', [404,413,422,503,504].includes(response.status) ? response.status : 502, undefined, {
    upstreamStatus: response.status, bridgeCorrelationId, playbackReason: stage
  });
};

export const recordingRoutes = ({ api, path, runtime }: { api: FastifyInstance; path: string; runtime: Runtime }) => {
  const root = path + '/cameras/:id';
  const camera = async (request: Parameters<Runtime['camera']>[0]['request'], id: string) => {
    const result = await runtime.camera({ request, id, permission: 'recordings.view' });
    if (!result.bridge.hasStorage(result.row.routeId)) throw new Failure('UNSUPPORTED', 422);
    return result;
  };
  api.get<{ Params: { id: string } }>(root + '/storage', async request => {
    const { bridge, row } = await camera(request, request.params.id);
    return bridgeRead({
      bridge, stableId: row.remote_id, path: '/cameras/' + row.routeId + '/storage', correlation: request.id, schema: storageResponse, failureKey: 'STORAGE_READ_FAILED'
    });
  });
  api.get<{ Params: { id: string } }>(root + '/recordings', async request => {
    const query = input({ schema: object({ date: recordingDate, stream: recordingStream.default('sub') }), value: request.query });
    const { bridge, row } = await camera(request, request.params.id);
    return bridgeRead({
      bridge, stableId: row.remote_id, path: '/cameras/' + row.routeId + '/recordings', correlation: request.id,
      search: '?' + new URLSearchParams(query), schema: recordingsResponse, failureKey: 'RECORDING_SEARCH_FAILED'
    });
  });
  api.get<{ Params: { id: string; recording: string } }>(root + '/recordings/:recording/metadata', async request => {
    const id = input({ schema: recordingId, value: request.params.recording });
    const { bridge, row } = await camera(request, request.params.id);
    const page = input({schema:object({page:z.coerce.number().int().nonnegative().max(2_000_000).default(0)}),value:request.query}).page;
    if (!bridge.hasRecordingMetadata(row.routeId)) throw new Failure('UNSUPPORTED',422);
    const response = await bridge.api({
      stableId: row.remote_id, path: '/cameras/' + row.routeId + '/recordings/' + id + '/metadata', search: page ? '?page=' + page : undefined,
      correlation: request.id, signal: AbortSignal.timeout(48_000)
    });
    if (!response.ok) throw await mediaFailure({ response });
    const result = recordingMetadataResponse.safeParse(await jsonResponse({ response, limit: 8 * 1024 * 1024 }));
    if (!result.success) throw new Failure('MEDIA_UNAVAILABLE',502);
    if ((await camera(request,row.id)).row.routeId !== row.routeId) throw new Failure('CAMERA_UNKNOWN',404);
    return result.data;
  });
  api.get<{ Params: { id: string; recording: string } }>(root + '/recordings/:recording/preview', async (request, reply) => {
    const id = input({ schema: recordingId, value: request.params.recording });
    const query = input({ schema: object({ offsetMs: z.coerce.number().int().min(0).max(86_400_000).default(0) }), value: request.query });
    const { bridge, row } = await camera(request, request.params.id);
    if (!bridge.hasRecordingPreview(row.routeId)) throw new Failure('UNSUPPORTED',422);
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(40_000)]);
    const read = (offset: number) => bridge.api({
      stableId: row.remote_id, path: '/cameras/' + row.routeId + '/recordings/' + id + '/preview',
      search: '?' + new URLSearchParams({ offsetMs: String(offset) }), correlation: request.id, signal
    });
    let offset = query.offsetMs;
    let response = await read(offset);
    // Older bridges return a generic 502 when the recording ends before another keyframe.
    if (offset > 0 && response.status === 502 && !response.headers.has('x-preview-offset-ms')) {
      await response.body?.cancel();
      offset = Math.max(0, offset - 8000);
      response = await read(offset);
    }
    if (!response.ok) throw await mediaFailure({ response });
    const selected = response.headers.get('x-preview-offset-ms');
    if (selected && /^\d+$/.test(selected) && Number(selected) <= offset) offset = Number(selected);
    const bytes = await responseBytes({ response, limit: 512 * 1024 });
    if (response.headers.get('content-type') !== 'image/jpeg' || bytes[0] !== 0xff || bytes[1] !== 0xd8
      || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Failure('MEDIA_UNAVAILABLE',502);
    // Recheck the grant after the bridge read, before releasing the image.
    if ((await camera(request, row.id)).row.routeId !== row.routeId) throw new Failure('CAMERA_UNKNOWN',404);
    return reply.header('x-preview-offset-ms',String(offset)).type('image/jpeg').send(bytes);
  });
  api.get<{ Params: { id: string; recording: string } }>(root + '/recordings/:recording/video', async (request, reply) => {
    const id = input({ schema: recordingId, value: request.params.recording });
    const { download,name } = input({ schema: object({ download: z.literal('1').optional(), name:z.string().regex(/^[A-Za-z0-9_-]{1,160}$/).optional() }), value: request.query });
    const { bridge, row, session, grant } = await camera(request, request.params.id);
    if (download && !grant.has('recordings.export')) throw new Failure('ACCESS_DENIED',403);
    if (!bridge.hasRecordings(row.routeId)) throw new Failure('UNSUPPORTED', 422);
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
      if (active.session.token !== session.token || active.row.routeId !== row.routeId || (download && !active.grant.has('recordings.export')) || !active.bridge.hasRecordings(active.row.routeId)) return stop();
      if (!controller.signal.aborted) checking = setTimeout(() => void validate().catch(stop), 700);
    };
    checking = setTimeout(() => void validate().catch(stop), 700);
    reply.raw.once('close', stop);
    try {
      const response = await bridge.api({
        stableId: row.remote_id, path: '/cameras/' + row.routeId + '/recordings/' + id + '/video',
        range, correlation: request.id, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(125_000)])
      });
      if (![200, 206, 416].includes(response.status)) {
        throw await mediaFailure({ response });
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
      if (active.session.token !== session.token || active.row.routeId !== row.routeId || (download && !active.grant.has('recordings.export'))) stop();
      if (controller.signal.aborted) throw new Failure('ACCESS_DENIED', 403);
      await audit({
        query: runtime.sql.query, actor: session.account.id, resource: row.id,
        action: download ? 'recording-export' : 'recording-playback', outcome: 'confirmed', correlation: request.id
      });
      stream = Readable.fromWeb(response.body as never, { signal: controller.signal, highWaterMark: 64 * 1024 });
      stream.once('close', stop);
      if (download) reply.header('content-disposition', 'attachment; filename="' + (name ?? ('recording-' + id)) + '.mp4"');
      return reply.code(response.status).type('video/mp4').header('accept-ranges', 'bytes')
        .header('content-length', length).header('x-accel-buffering', 'no').send(stream);
    } catch (error) {
      stop();
      throw error;
    }
  });
};
