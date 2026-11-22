import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Bridge } from './bridge.js';
import type { Runtime } from './runtime.js';
import { input, uuid } from './runtime.js';
import { sendOutcome } from './camera-routes.js';
import { Failure } from './errors.js';
import { jsonResponse, responseBytes } from './net.js';
import { audit } from './db.js';
import { correlationPattern } from '../shared/urls.js';
import { record } from './bridge-channels.js';
import { nearestUndatedPhoto } from './nearest-photo.js';
import { timeLapseThumbnail } from './time-lapse-thumbnail.js';
import { recordingExportRoute } from './recording-export.js';
import { RecordingPreviewCache } from '../shared/recording-preview-cache.js';
import { recordingStages, recordingMetadataResponse, recordingPhotos, recordingDate, recordingId, recordingsResponse, recordingStream, storageResponse } from '../shared/recordings.js';

const object = z.strictObject;
const mediaPreparationTimeoutMs = 125_000;

const bridgeRead = async <T>({ bridge, stableId, path, search, correlation, schema, failureKey, limit, timeoutMs = 48_000, signal }: {
  bridge: Bridge; stableId: string; path: string; search?: string; correlation: string; schema: z.ZodType<T>; limit?: number; timeoutMs?: number; signal?: AbortSignal;
  failureKey: 'STORAGE_READ_FAILED' | 'RECORDING_SEARCH_FAILED'
}) => {
  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await bridge.api({ path, stableId, search, correlation, signal: signal ? AbortSignal.any([signal,deadline]) : deadline });
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
  const parsed = schema.safeParse(await jsonResponse({ response, limit }).catch(() => undefined));
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
  recordingExportRoute(api, path, runtime);
  const root = path + '/cameras/:id';
  const previews = new RecordingPreviewCache<Buffer>();
  const stopWatching = runtime.observeBridgeChanges(() => previews.clear());
  api.addHook('onClose', async () => { stopWatching(); previews.clear(); });
  const camera = async (request: Parameters<Runtime['camera']>[0]['request'], id: string, permission: 'recordings.view' | 'storage.format' = 'recordings.view') => {
    const result = await runtime.camera({ request, id, permission });
    if (!result.bridge.hasStorage(result.row.routeId)) throw new Failure('UNSUPPORTED', 422);
    return result;
  };
  const photoJobs = new Map<string, Promise<Buffer>>();
  const photoCamera = async (request: Parameters<Runtime['camera']>[0]['request'], id: string) => {
    const active = await runtime.camera({ request, id, permission:'recordings.view' });
    if (!active.bridge.hasTimeLapsePhotos(active.row.routeId)) throw new Failure('UNSUPPORTED',422);
    return active;
  };
  const photoDate = object({date:recordingDate});
  const listPhotos = (bridge: Bridge, row: {remote_id:string; routeId:string}, date: string, correlation: string, window?: {from:string;to:string}, signal?:AbortSignal) =>
    bridgeRead({bridge, stableId:row.remote_id, path:'/cameras/'+row.routeId+'/time-lapse/photos',
      search:'?'+new URLSearchParams({date,...window}), correlation, signal, schema:recordingPhotos, failureKey:'RECORDING_SEARCH_FAILED',
      limit:6 * 1024 * 1024, timeoutMs:65_000});
  api.get<{ Params: {id:string} }>(root + '/time-lapse/photos', async request => {
    const {date} = input({schema:photoDate,value:request.query});
    const {bridge,row} = await photoCamera(request,request.params.id);
    const {photos} = await listPhotos(bridge,row,date,request.id);
    const active = await photoCamera(request,row.id);
    if (active.bridge !== bridge || active.row.routeId !== row.routeId || active.row.remote_id !== row.remote_id) throw new Failure('CAMERA_UNKNOWN',404);
    return {date, undatedCount:photos.filter(p => p.capturedAt === null).length, photos:photos.flatMap(({id,capturedAt}) => capturedAt?.startsWith(date+'T') ? [{id,capturedAt}] : [])};
  });
  let activePhotoLookups = 0;
  api.get<{Params:{id:string}}>(root + '/time-lapse/photos/nearest',async (request,reply) => {
    const seconds = z.coerce.number().int().min(0).max(86_399);
    const {date,second,radius} = input({schema:photoDate.extend({second:seconds,radius:seconds}),value:request.query});
    const {bridge,row} = await photoCamera(request,request.params.id);
    if (activePhotoLookups >= 4) throw new Failure('MEDIA_UNAVAILABLE',503);
    const canceled = new AbortController();
    const signal = AbortSignal.any([canceled.signal,AbortSignal.timeout(60_000)]);
    reply.raw.once('close',() => canceled.abort());
    const clock = (value:number) => new Date(value*1000).toISOString().slice(11,19);
    activePhotoLookups++;
    try {
      const match = await nearestUndatedPhoto(second,radius,async (from,to) => {
        signal.throwIfAborted();
        const {photos} = await listPhotos(bridge,row,date,request.id,{from:clock(from),to:clock(to)},signal);
        return photos.filter(photo => photo.capturedAt === null).map(photo => photo.id);
      });
      const active = await photoCamera(request,row.id);
      if (active.bridge !== bridge || active.row.routeId !== row.routeId || active.row.remote_id !== row.remote_id) throw new Failure('CAMERA_UNKNOWN',404);
      return {photo:match ? {id:match.id,capturedAt:date+'T'+clock(match.time)} : null};
    } finally { activePhotoLookups--; }
  });
  api.get<{ Params: {id:string; photo:string} }>(root + '/time-lapse/photos/:photo/preview', async (request,reply) => {
    const {date} = input({schema:photoDate,value:request.query});
    const id = input({schema:recordingId,value:request.params.photo});
    const {bridge,row} = await photoCamera(request,request.params.id);
    const key = [row.id,row.remote_id,row.routeId,'photo',date,id].join('/');
    const hit = previews.exact(key,0);
    if (hit) return reply.type('image/jpeg').send(hit.jpeg);
    const load = async () => {
      const read = () => bridge.api({stableId:row.remote_id,path:'/cameras/'+row.routeId+'/time-lapse/photos/'+id,
        search:'?preview=true',correlation:request.id,signal:AbortSignal.timeout(65_000)});
      let response = await read();
      if (response.status === 404) {
        await response.body?.cancel();
        const {photos} = await listPhotos(bridge,row,date,request.id);
        if (!photos.some(p => p.id === id && (p.capturedAt === null || p.capturedAt.startsWith(date+'T')))) throw new Failure('MEDIA_UNAVAILABLE',404);
        response = await read();
      }
      if (!response.ok) throw await mediaFailure({response});
      return timeLapseThumbnail(response);
    };
    let job = photoJobs.get(key);
    if (!job) {
      if (photoJobs.size >= 8) throw new Failure('MEDIA_UNAVAILABLE',503);
      job = load().finally(() => photoJobs.delete(key));
      photoJobs.set(key,job);
    }
    const jpeg = await job;
    const active = await photoCamera(request,row.id);
    if (active.bridge !== bridge || active.row.routeId !== row.routeId || active.row.remote_id !== row.remote_id) throw new Failure('CAMERA_UNKNOWN',404);
    previews.store(key,0,{jpeg,offsetMs:0},jpeg.length);
    return reply.type('image/jpeg').send(jpeg);
  });
  api.get<{ Params: { id: string } }>(root + '/storage', async request => {
    const { format } = input({ schema: object({ format: z.enum(['true', 'false']).optional() }), value: request.query });
    const { bridge, row } = await camera(request, request.params.id, format === 'true' ? 'storage.format' : 'recordings.view');
    const canFormat = format !== 'false' && row.permissions.includes('storage.format');
    const storage = await bridgeRead({
      bridge, stableId: row.remote_id, path: '/cameras/' + row.routeId + '/storage', search: canFormat ? '?format=true' : undefined,
      correlation: request.id, schema: storageResponse, failureKey: 'STORAGE_READ_FAILED'
    });
    if (!canFormat) for (const card of storage.cards) delete card.formatSource;
    return storage;
  });
  api.post<{ Params: {id: string} }>(root + '/storage/format', async (request, reply) => {
    const { row, bridge, session } = await runtime.camera({ request, id: request.params.id, permission: 'storage.format', mutate: true });
    if (!bridge.hasStorage(row.routeId)) throw new Failure('UNSUPPORTED', 422);
    const { operationId, ...selection } = input({schema: object({operationId: uuid, slot: z.number().int().nonnegative().max(0xffffffff),
      source: recordingId, confirm: z.literal(true)}), value: request.body});
    const value = await runtime.ops.run({id: operationId, actor: session.account.id, resource: row.id, action: 'storage.format',
      correlation: request.id, input: selection, serialized: true, execute: async () => {
        const response = await bridge.api({path:'/cameras/'+row.routeId+'/storage/format', stableId:row.remote_id, data:selection,
          correlation:request.id, signal:AbortSignal.timeout(40_000)});
        const body = record(await jsonResponse({response,limit:16_384}).catch(()=>({})));
        const bridgeCorrelationId = typeof body.correlation_id === 'string' && correlationPattern.test(body.correlation_id) ? body.correlation_id : undefined;
        if (response.status === 202 && body.outcome === 'acknowledged' && body.slot === selection.slot) {
          previews.clearCamera(row.id);
          return {outcome:'unverified', reason:'STORAGE_FORMAT_ACCEPTED', bridgeCorrelationId};
        }
        const rejected: Record<string,string> = {API_STORAGE_FORMAT_INVALID:'BAD_INPUT',API_STORAGE_FORMAT_UNSUPPORTED:'UNSUPPORTED',
          API_CAMERA_IDENTITY_CHANGED:'CAMERA_UNKNOWN',API_STORAGE_FORMAT_REJECTED:'COMMAND_REJECTED',API_READ_BUSY:'COMMAND_BUSY',
          API_STORAGE_FORMAT_CHECK_FAILED:'STORAGE_READ_FAILED',API_SCOPE_DENIED:'ACCESS_DENIED'};
        const reason = typeof body.errorKey === 'string' ? rejected[body.errorKey] : undefined;
        if (reason || response.status===404 || response.status===405) return {outcome:'rejected',reason:reason ?? 'UNSUPPORTED',bridgeCorrelationId};
        previews.clearCamera(row.id);
        return {outcome:'unknown',reason:'OUTCOME_UNKNOWN',bridgeCorrelationId};
      }});
    return sendOutcome({reply,value});
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
      correlation: request.id, signal: AbortSignal.timeout(mediaPreparationTimeoutMs)
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
    const clip = [row.id, row.remote_id, row.routeId, id].join('/');
    const cached = previews.exact(clip, query.offsetMs);
    if (cached) return reply.header('x-preview-offset-ms', String(cached.offsetMs)).type('image/jpeg').send(cached.jpeg);
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
    const active = await camera(request, row.id);
    if (active.bridge !== bridge || active.row.remote_id !== row.remote_id || active.row.routeId !== row.routeId) throw new Failure('CAMERA_UNKNOWN',404);
    previews.store(clip, query.offsetMs, { jpeg: bytes, offsetMs: offset }, bytes.length);
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
        range, correlation: request.id, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(mediaPreparationTimeoutMs)])
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
