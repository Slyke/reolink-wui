import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import yazl from 'yazl';
import { z } from 'zod';
import { recordingDate, recordingId, recordingsResponse } from '../shared/recordings.js';
import { audit } from './db.js';
import { Failure, report } from './errors.js';
import { jsonResponse } from './net.js';
import { input, type Runtime } from './runtime.js';

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/);
const querySchema = z.strictObject({
  kind: z.enum(['videos', 'photos']), date: recordingDate, from: time.optional(), to: time.optional(),
  download: z.literal('1').optional()
}).refine(q => Boolean(q.from) === Boolean(q.to) && (!q.from || (q.kind === 'photos' && q.from <= q.to!)));
const gallerySchema = z.object({ photos: z.array(z.object({
  id: recordingId, capturedAt: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/).nullable()
})).max(20_000) });
type Entry = { id: string; name: string; path: string; list: string };
const safeTime = (stamp: string) => stamp.replaceAll(':', '-');
const clock = (second: number) => new Date(second * 1000).toISOString().slice(11,19);
const cameraPart = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0,80);

export function recordingExportRoute(api: FastifyInstance, base: string, runtime: Runtime) {
  api.get<{ Params: { id: string } }>(base + '/cameras/:id/recordings/export', async (request, reply) => {
    const q = input({ schema: querySchema, value: request.query });
    const access = () => runtime.camera({ request, id: request.params.id, permission: 'recordings.view' });
    const { bridge, row, grant, session } = await access();
    const supported = () => q.kind === 'photos' ? bridge.hasTimeLapsePhotos(row.routeId) : bridge.hasRecordings(row.routeId);
    if (!grant.has('recordings.export')) throw new Failure('ACCESS_DENIED',403);
    if (!supported()) throw new Failure('UNSUPPORTED',422);
    const root = '/cameras/' + row.routeId;
    const controller = new AbortController();
    const ensureAccess = async () => {
      const active = await access();
      if (active.session.token !== session.token || active.bridge !== bridge || active.row.routeId !== row.routeId ||
          active.row.remote_id !== row.remote_id || !active.grant.has('recordings.export') || !supported()) throw new Failure('ACCESS_DENIED',403);
    };
    const read = (path: string, search?: string, ms = 65_000) => bridge.api({
      path: root + path, search, correlation: request.id, stableId: row.remote_id,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(ms)])
    });
    const parse = async <T>(response: Response, schema: z.ZodType<T>) => {
      if (!response.ok) {
        await response.body?.cancel();
        throw new Failure('RECORDING_SEARCH_FAILED', [503,504].includes(response.status) ? response.status : 502);
      }
      const result = schema.safeParse(await jsonResponse({ response, limit: 6 * 1024 * 1024 }));
      if (!result.success) throw new Failure('RECORDING_SEARCH_FAILED',502);
      return result.data;
    };
    const listEntries = async (list: string, start = 0, end = 86_399): Promise<Entry[]> => {
      const params = new URLSearchParams({date:q.date});
      if (list === 'photos') {
        if (q.from && q.to) {params.set('from',q.from); params.set('to',q.to);}
        const data = await parse(await read('/time-lapse/photos', '?' + params), gallerySchema);
        return data.photos.map(p => ({
          id:p.id, list, path:'/time-lapse/photos/' + p.id,
          name:(p.capturedAt ? safeTime(p.capturedAt) : q.date) + '_' + p.id + '.png'
        }));
      }
      params.set('stream',list);
      if (start !== 0 || end !== 86_399) { params.set('from',clock(start)); params.set('to',clock(end)); }
      const data = await parse(await read('/recordings','?' + params), recordingsResponse);
      if (data.stream !== list || data.date !== q.date) throw new Failure('RECORDING_SEARCH_FAILED',502);
      if (data.truncated) {
        if (start === end) throw new Failure('RECORDING_SEARCH_FAILED',502);
        const middle = Math.floor((start + end) / 2);
        const first = await listEntries(list,start,middle);
        return first.concat(await listEntries(list,middle+1,end));
      }
      return data.recordings.map(clip => ({
        id:clip.id, list, path:'/recordings/' + clip.id + '/video',
        name:clip.stream + '/' + safeTime(clip.start) + '_' + clip.id + '.mp4'
      }));
    };
    let output: Readable | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (cause?: Error) => {
      if (controller.signal.aborted) return;
      clearTimeout(timer);
      controller.abort();
      output?.destroy(cause);
    };
    reply.raw.once('close', () => stop());
    try {
      // The SD index is independently accessible when a card-capacity read fails.
      const lists = q.kind === 'photos' ? ['photos'] : ['main','sub'];
      const entries: Entry[] = [];
      for (const list of new Set(lists)) {
        await ensureAccess();
        entries.push(...await listEntries(list));
      }
      await ensureAccess();
      if (!q.download) return { count:entries.length };
      if (!entries.length) throw new Failure('MEDIA_UNAVAILABLE',404);
      const load = async (entry: Entry) => {
        await ensureAccess();
        let response = await read(entry.path, undefined, 125_000);
        // An archive can take longer than the bridge's ten-minute search reference.
        if (response.status === 404) {
          await response.body?.cancel();
          if (!(await listEntries(entry.list)).some(found => found.id === entry.id)) throw new Failure('MEDIA_UNAVAILABLE',404);
          response = await read(entry.path, undefined, 125_000);
        }
        const type = q.kind === 'photos' ? 'image/png' : 'video/mp4';
        const limit = q.kind === 'photos' ? 128 * 1024 * 1024 : 768 * 1024 * 1024;
        const length = Number(response.headers.get('content-length'));
        if (response.status !== 200 || response.headers.get('content-type') !== type || !response.body ||
            !Number.isSafeInteger(length) || length <= 0 || length > limit) {
          await response.body?.cancel();
          throw new Failure('MEDIA_UNAVAILABLE',502);
        }
        return Readable.fromWeb(response.body as never, { signal:controller.signal, highWaterMark:64 * 1024 });
      };
      const check = () => {timer = setTimeout(() => {
        if (!controller.signal.aborted) void ensureAccess().then(() => { if (!controller.signal.aborted) check(); }, stop);
      },700);};
      check();
      const first = await load(entries[0]);
      first.on('error', cause => stop(cause));
      await ensureAccess();
      await audit({query:runtime.sql.query, actor:session.account.id, resource:row.id,
        action:'recording-export', outcome:'confirmed', correlation:request.id});
      const zip = new yazl.ZipFile();
      output = zip.outputStream as Readable;
      output.once('error', cause => {
        report({error:cause instanceof Failure ? cause : new Failure('MEDIA_UNAVAILABLE',502),
          correlationId:request.id,caller:'api::recording-export'});
      });
      zip.on('error', stop);
      for (const [index, entry] of entries.entries()) {
        zip.addReadStreamLazy(entry.name, {compress:false}, done => {
          if (controller.signal.aborted) return;
          void (index === 0 ? Promise.resolve(first) : load(entry)).then(stream => {
            if (index > 0) stream.once('error',cause => stop(cause));
            done(null,stream);
          }, stop);
        });
      }
      zip.end();
      const range = q.from && q.to ? '_' + safeTime(q.from) + '_' + safeTime(q.to) : '';
      const filename = cameraPart(row.routeId) + '_' + q.date + range + '_' + q.kind + '.zip';
      return reply.type('application/zip').header('content-disposition', 'attachment; filename="' + filename + '"')
        .header('cache-control','private, no-store').header('x-accel-buffering','no').send(output);
    } catch (cause) {stop(); throw cause;}
  });
}
