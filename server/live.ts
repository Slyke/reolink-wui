import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Runtime } from './runtime.js';
import { input, uuid } from './runtime.js';
import { camerasFor, audit, type Account, type CameraRef } from './db.js';
import { minPreviewIntervalMs, maxPreviewIntervalMs, previewAlerts } from '../shared/playback.js';
import { available } from './cameras.js';
import type { BridgeUpdate } from './bridge.js';
import { Failure } from './errors.js';
import { Playback, playbackStreams, rtspProxyUrl } from './playback.js';
import { sendOutcome } from './camera-routes.js';

const previewQuery = z.strictObject({ refresh: z.literal('true').optional() });
const playbackFields = {
  operationId: uuid,
  previewIntervalMs: z.number().int().min(minPreviewIntervalMs).max(maxPreviewIntervalMs).optional(),
  refreshOnAlert: z.enum(previewAlerts).optional()
};

const eventFilter = z.strictObject({ camera: uuid.optional(), type: z.string().max(120).optional() });

export const liveRoutes = ({ api, path, runtime }: { api: FastifyInstance; path: string; runtime: Runtime }) => {
  let subscriptions = 0;
  const playback = new Playback();
  const sessions = new Map<string, {
    actor: string; token: string; camera: string; stream: string; source: string | null; expires: number; active: boolean; cancel?: () => void
  }>();
  api.get(path + '/events', async (request, reply) => {
    const { account } = await runtime.auth.require({ request });
    const filter = input({ schema: eventFilter, value: request.query });
    if (filter.camera) await runtime.camera({ request, id: filter.camera, permission: 'events' });
    const select = async (actor: Account) => (await camerasFor({ sql: runtime.sql, account: actor })).filter(row => (
      (!filter.camera || filter.camera === row.id) && runtime.bridges.get(row.bridge_id)?.includes(row.remote_id)
    ));
    const rows = await select(account);
    if (subscriptions >= 128) throw new Failure('MEDIA_LIMIT', 429);
    const fingerprint = (items: typeof rows) => JSON.stringify(items.map(row => [row.id, row.permissions]));
    const allowed = fingerprint(rows);
    const byBridge = new Map(rows.map(row => [row.bridge_id + '/' + row.remote_id, {
      camera: row.id, grants: new Set<string>(row.permissions)
    }]));
    const stream = new PassThrough({ highWaterMark: 16_384 });
    subscriptions++;
    const send = (payload: unknown) => {
      if (!stream.write('data: ' + JSON.stringify(payload) + '\n\n')) stream.destroy();
    };
    const updates: { bridge: string; update: BridgeUpdate }[] = [];
    let gap = false;
    let lastPing = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const subscriptionsForBridge = [...runtime.bridges].filter(([id]) => rows.some(row => row.bridge_id === id)).map(([id, bridge]) => (
      bridge.observe(update => {
        if (updates.length >= 128) {
          gap = true;
          updates.length = 0;
        }
        updates.push({ bridge: id, update });
      })
    ));
    const tick = async () => {
      if (stream.destroyed) return;
      const current = await runtime.auth.session({ request });
      if (stream.destroyed) return;
      if (!current || current.account.id !== account.id || fingerprint(await select(current.account)) !== allowed) {
        send({ kind: 'access-changed' });
        stream.end();
        return;
      }
      if (gap) {
        send({ kind: 'gap' });
        gap = false;
      }
      for (const { bridge, update } of updates.splice(0)) {
        if (update.kind === 'feed') { send({ kind: 'feed' }); continue; }
        const mapped = byBridge.get(bridge + '/' + update.camera);
        if (!mapped) continue;
        if (update.kind === 'event' && mapped.grants.has('events')
          && (!filter.type || [update.topic, update.entry.event.vendorTopic].includes(filter.type))) {
          send({ kind: 'event', camera: mapped.camera, ...update.entry });
        } else if (update.kind === 'snapshot' && mapped.grants.has('view')) {
          if (['state/settings', 'state/ptz', 'rules'].includes(update.topic)
            || (update.topic.startsWith('state/') && !mapped.grants.has('events'))) continue;
          send({ kind: 'state', camera: mapped.camera });
        }
      }
      if (Date.now() - lastPing > 12_000) {
        stream.write(': keep-alive\n\n');
        lastPing = Date.now();
      }
      if (!stream.destroyed) timer = setTimeout(() => void tick().catch(() => stream.destroy()), 600);
    };
    stream.on('close', () => {
      subscriptions--;
      clearTimeout(timer);
      subscriptionsForBridge.forEach(unsubscribe => unsubscribe());
    });
    reply.raw.once('close', () => stream.destroy());
    // Event history is fetched separately from this live connection.
    send({ kind: 'connected' });
    timer = setTimeout(() => void tick().catch(() => stream.destroy()), 600);
    return reply.type('text/event-stream; charset=utf-8').header('x-accel-buffering', 'no').send(stream);
  });

  const signedCamera = ({ request, id, mutate }: { request: FastifyRequest; id: string; mutate?: boolean }) => (
    runtime.camera({ request, id, permission: 'media.live', mutate })
  );

  const sourceSummary = ({ row }: { row: CameraRef }) => ({
    source: row.rtsp_proxy ? 'proxy' : 'direct', proxyUrl: row.rtsp_proxy ?? undefined,
    previewIntervalMs: row.preview_interval_ms, refreshOnAlert: row.preview_refresh_on_alert
  });

  const managePlayback = async ({ request, id, mutate }: { request: FastifyRequest; id: string; mutate?: boolean }) => {
    const current = await signedCamera({ request, id, mutate });
    if (current.session.account.admin !== 1) throw new Failure('ACCESS_DENIED', 403);
    return current;
  };

  api.get<{ Params: { id: string } }>(path + '/cameras/:id/playback', async request => {
    const { row } = await managePlayback({ request, id: request.params.id });
    return sourceSummary({ row });
  });

  api.put<{ Params: { id: string } }>(path + '/cameras/:id/playback', async (request, reply) => {
    const { row, session } = await managePlayback({ request, id: request.params.id, mutate: true });
    const data = input({ schema: z.discriminatedUnion('source', [
      z.strictObject({ ...playbackFields, source: z.literal('direct') }),
      z.strictObject({ ...playbackFields, source: z.literal('proxy'), proxyUrl: rtspProxyUrl })
    ]), value: request.body });
    const proxy = data.source === 'proxy' ? data.proxyUrl.href : null;
    const { previewIntervalMs, refreshOnAlert } = data;
    const value = await runtime.ops.run({
      id: data.operationId, actor: session.account.id, action: 'playback.source', resource: row.id,
      input: previewIntervalMs === undefined && refreshOnAlert === undefined ? proxy : [proxy, previewIntervalMs, refreshOnAlert],
      correlation: request.id, execute: async () => {
        const [saved] = await runtime.sql.query<CameraRef>(
          'UPDATE cameras SET rtsp_proxy=$1, preview_interval_ms=COALESCE($2,preview_interval_ms), '
          + 'preview_refresh_on_alert=COALESCE($3,preview_refresh_on_alert) WHERE id=$4 RETURNING *',
          proxy, previewIntervalMs ?? null, refreshOnAlert ?? null, row.id
        );
        if (!saved) throw new Failure('CAMERA_UNKNOWN', 404);
        return { outcome: 'confirmed', data: sourceSummary({ row: saved }) };
      }
    });
    return sendOutcome({ reply, value });
  });

  api.get<{ Params: { id: string } }>(path + '/cameras/:id/preview', async (request, reply) => {
    const { bridge, row } = await signedCamera({ request, id: request.params.id });
    const { refresh } = input({ schema: previewQuery, value: request.query });
    const tag = request.headers['if-none-match'];
    const { frame, etag, capturedAt } = await playback.preview({
      bridge, row, correlation: request.id, refresh: refresh === 'true',
      ifNoneMatch: typeof tag === 'string' && tag.length <= 512 ? tag : undefined
    });
    const current = await signedCamera({ request, id: row.id });
    if (current.row.rtsp_proxy !== row.rtsp_proxy) throw new Failure('MEDIA_UNAVAILABLE', 409);
    if (etag) reply.header('etag', etag);
    if (capturedAt) reply.header('x-preview-captured-at', capturedAt);
    return frame ? reply.type(frame.type).send(frame.bytes) : reply.code(304).send();
  });

  api.post<{ Params: { id: string } }>(path + '/cameras/:id/media-sessions', async (request, reply) => {
    const data = input({ schema: z.strictObject({ operationId: uuid, stream: z.enum(['main', 'sub']) }), value: request.body });
    const current = await signedCamera({ request, id: request.params.id, mutate: true });
    const { bridge, row, session } = current;
    if (!playbackStreams({ bridge, row }).includes(data.stream)) throw new Failure('MEDIA_UNAVAILABLE', 422);
    if (!row.rtsp_proxy && !available({ bridge, remote: row.remote_id }).online) throw new Failure('CAMERA_OFFLINE', 409);
    for (const [id, value] of sessions) {
      if (value.expires <= Date.now()) {
        value.cancel?.();
        sessions.delete(id);
      }
    }
    if (sessions.size >= 64 || [...sessions.values()].filter(value => value.actor === session.account.id).length >= 8) {
      throw new Failure('MEDIA_LIMIT', 429);
    }
    const result = await runtime.ops.run({
      actor: session.account.id, action: 'media-session', resource: row.id, id: data.operationId,
      correlation: request.id, input: data.stream,
      execute: async () => {
        const id = randomUUID();
        const expires = Math.min(Date.now() + 120_000, Number(session.account.expires));
        sessions.set(id, { actor: session.account.id, token: session.token, camera: row.id, stream: data.stream, source: row.rtsp_proxy, expires, active: false });
        return { outcome: 'confirmed', data: { url: '/api/v1/media/' + id, expiresAt: new Date(expires).toISOString(), transport: 'mjpeg' } };
      }
    });
    return reply.send(result);
  });

  api.get<{ Params: { id: string } }>(path + '/media/:id', async (request, reply) => {
    const id = input({ schema: uuid, value: request.params.id });
    const media = sessions.get(id);
    if (!media || media.expires <= Date.now() || media.active) throw new Failure('ACCESS_DENIED', 403);
    const { bridge, row, session } = await signedCamera({ request, id: media.camera });
    if (media.actor !== session.account.id || media.token !== session.token || row.rtsp_proxy !== media.source
      || !playbackStreams({ bridge, row }).includes(media.stream)) {
      throw new Failure('ACCESS_DENIED', 403);
    }
    if (media.active || sessions.get(id) !== media) throw new Failure('ACCESS_DENIED', 403);
    media.active = true;
    const controller = new AbortController();
    const closed = () => controller.abort();
    media.cancel = closed;
    const expiry = setTimeout(closed, Math.max(0, media.expires - Date.now()));
    let validation: ReturnType<typeof setTimeout>;
    const check = async () => {
      const active = await signedCamera({ request, id: media.camera });
      if (active.session.token !== media.token || active.row.rtsp_proxy !== media.source) return closed();
      if (!controller.signal.aborted) validation = setTimeout(() => void check().catch(closed), 700);
    };
    validation = setTimeout(() => void check().catch(closed), 700);
    const cleanup = () => {
      clearTimeout(expiry);
      clearTimeout(validation);
      sessions.delete(id);
      closed();
    };
    reply.raw.once('close', cleanup);
    try {
      const { type, stream } = await playback.open({
        bridge, row, stream: media.stream, signal: controller.signal, correlation: request.id
      });
      stream.once('close', cleanup);
      await audit({
        query: runtime.sql.query, actor: media.actor, resource: row.id, action: 'media-stream',
        outcome: 'confirmed', correlation: request.id
      });
      return reply.type(type).header('x-accel-buffering', 'no').send(stream);
    } catch (error) {
      cleanup();
      throw error;
    }
  });

  api.delete<{ Params: { id: string } }>(path + '/media/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { token } = await runtime.auth.require({ request, mutate: true });
    const id = input({ schema: uuid, value: request.params.id });
    const media = sessions.get(id);
    if (media?.token === token) { media.cancel?.(); sessions.delete(id); }
    return reply.code(204).send();
  });
};
