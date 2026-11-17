import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { correlationPattern, segment } from '../shared/urls.js';
import { record } from './bridge-channels.js';
import { storeCamera } from './db.js';
import { Failure } from './errors.js';
import { sendOutcome } from './camera-routes.js';
import { jsonResponse } from './net.js';
import { input, uuid, type Runtime } from './runtime.js';
import type { Bridge } from './bridge.js';

const object = z.strictObject;
const safeKey = z.string().regex(segment);
const states = [
  'waiting', 'identity-mismatch', 'local-setup-required', 'recovery-required', 'verified', 'restart-required',
  'active', 'previous-credential-valid', 'not-started', 'in-progress'
];
const shape = ({ response, body }: { response: Response; body: unknown }) => {
  const raw = record(body);
  const status = typeof raw.status === 'string' && states.includes(raw.status) ? raw.status : undefined;
  if (!status && !response.ok) throw new Failure(
    response.status === 404 ? 'ENROLLMENT_MISSING' : (response.status === 422 ? 'UNSUPPORTED' : 'OUTCOME_UNKNOWN'),
    response.status === 404 ? 404 : (response.status === 422 ? 422 : 502),
    response.status >= 500 ? 'unknown' : undefined
  );
  return {
    status: status ?? 'waiting',
    remote: typeof raw.camera_id === 'string' && segment.test(raw.camera_id) ? raw.camera_id : undefined,
    bridgeCorrelationId: typeof raw.correlation_id === 'string' && correlationPattern.test(raw.correlation_id) ? raw.correlation_id : undefined
  };
};

export const enrollmentRoutes = ({ api, path, runtime }: { api: FastifyInstance; path: string; runtime: Runtime }) => {
  const enrollments = path + '/enrollments';
  const bridgeFor = (id: string) => {
    const bridge = runtime.bridges.get(id);
    if (!bridge?.has('enrollment')) throw new Failure('UNSUPPORTED', 422);
    return bridge;
  };
  const progress = async ({ bridge, endpoint, data, correlation }: {
    bridge: Bridge; endpoint: string; data?: unknown; correlation: string
  }) => {
    const response = await bridge.app({ path: endpoint, data, method: data === undefined ? 'GET' : 'POST', admin: true, correlation });
    const value = shape({ response, body: await jsonResponse({ response }) });
    let cameraId: string | undefined;
    if (value.remote && bridge.includes(value.remote)) {
      const row = await storeCamera({ sql: runtime.sql, bridge: bridge.config.id, remote: value.remote });
      cameraId = row.id;
    }
    return { status: value.status, cameraId, bridgeCorrelationId: value.bridgeCorrelationId };
  };
  const outcome = (status: string) => {
    if (status === 'recovery-required') return 'unknown';
    if (['verified', 'active', 'restart-required'].includes(status)) return 'confirmed';
    return 'unverified';
  };
  api.get(enrollments, async request => {
    await runtime.admin({ request });
    return {
      enrollments: (await runtime.sql.query('SELECT id,bridge_id,created FROM enrollments ORDER BY created DESC LIMIT 100'))
    };
  });
  api.get<{ Params: { bridge: string } }>(path + '/admin/bridges/:bridge/enrollment-targets', async request => {
    await runtime.admin({ request });
    const bridge = bridgeFor(request.params.bridge);
    const response = await bridge.app({ path: '/enrollment-targets', admin: true, correlation: request.id });
    const result = record(await jsonResponse({ response }));
    if (!response.ok || !Array.isArray(result.targets)) throw new Failure('BRIDGE_UNAVAILABLE', 502);
    return { targets: result.targets.filter(value => typeof value === 'string' && segment.test(value)).slice(0, 64) };
  });
  api.post(enrollments, async (request, reply) => {
    const { account } = await runtime.admin({ request, mutate: true });
    const data = input({
      schema: object({
        operationId: uuid, bridge: safeKey, target: safeKey,
        uid: z.string().regex(/^[a-zA-Z0-9]{8,40}$/).optional(),
        serial: z.string().regex(/^[a-zA-Z0-9-]{4,64}$/).optional(),
        method: z.enum(['initialize', 'import']), confirmation: z.literal(true)
      }).refine(value => (value.uid || value.serial) && (value.method !== 'initialize' || value.uid)),
      value: request.body
    });
    const bridge = bridgeFor(data.bridge);
    const value = await runtime.ops.run({
      id: data.operationId, actor: account.id, resource: data.operationId, action: 'enrollment.start', correlation: request.id,
      input: data, execute: async () => {
        const intent = { id: data.operationId, uid: data.uid, serial: data.serial, target: data.target, method: data.method, confirmation: true };
        await runtime.sql.query('INSERT INTO enrollments(id,bridge_id,owner_id,created,request) VALUES ($1,$2,$3,$4,$5)',
          data.operationId, bridge.config.id, account.id, Date.now(), JSON.stringify(intent));
        const value = await progress({
          bridge, endpoint: '/enrollments', correlation: request.id,
          data: intent
        });
        return { outcome: outcome(value.status), data: value, bridgeCorrelationId: value.bridgeCorrelationId };
      }
    });
    return sendOutcome({ reply, value });
  });
  const enrollment = async (id: string) => {
    const validated = input({ schema: uuid, value: id });
    const [row] = await runtime.sql.query<{ bridge_id: string; request: string | null }>('SELECT bridge_id,request FROM enrollments WHERE id=$1', validated);
    if (!row) throw new Failure('ENROLLMENT_MISSING', 404);
    return { bridge: bridgeFor(row.bridge_id), intent: row.request };
  };
  api.get<{ Params: { id: string } }>(enrollments + '/:id', async request => {
    await runtime.admin({ request });
    const { bridge } = await enrollment(request.params.id);
    return progress({ bridge, endpoint: '/enrollments/' + request.params.id, correlation: request.id });
  });
  api.post<{ Params: { id: string } }>(enrollments + '/:id/resume', async (request, reply) => {
    const { account } = await runtime.admin({ request, mutate: true });
    const { bridge, intent } = await enrollment(request.params.id);
    const { operationId, method } = input({ schema: object({ operationId: uuid, method: z.literal('import').optional() }), value: request.body });
    const value = await runtime.ops.run({
      id: operationId, actor: account.id, resource: request.params.id, action: 'enrollment.resume', correlation: request.id,
      input: method, execute: async () => {
        let value;
        try {
          value = await progress({
            bridge, endpoint: '/enrollments/' + request.params.id + '/resume', data: { method }, correlation: request.id
          });
        } catch (error) {
          if (!(error instanceof Failure) || error.key !== 'ENROLLMENT_MISSING' || !intent) throw error;
          // A failed hop may never have delivered the original request. The same durable ID is
          // safe to submit after the bridge confirms it has no record of the operation.
          value = await progress({ bridge, endpoint: '/enrollments', data: JSON.parse(intent), correlation: request.id });
        }
        return { outcome: outcome(value.status), data: value, bridgeCorrelationId: value.bridgeCorrelationId };
      }
    });
    return sendOutcome({ reply, value });
  });

  const cameras = path + '/cameras/:id/rotation';
  api.get<{ Params: { id: string } }>(cameras, async request => {
    const { bridge, row } = await runtime.camera({ request, id: request.params.id, permission: 'device.rotate' });
    if (!bridge.has('enrollment')) throw new Failure('UNSUPPORTED', 422);
    return progress({ bridge, endpoint: '/cameras/' + row.remote_id + '/rotation', correlation: request.id });
  });
  api.post<{ Params: { id: string } }>(cameras, async (request, reply) => {
    const { operationId, action } = input({
      schema: object({ operationId: uuid, action: z.enum(['rotate', 'reconcile']), confirmation: z.literal(true) }), value: request.body
    });
    const { bridge, row, session } = await runtime.camera({
      request, id: request.params.id, permission: 'device.rotate', mutate: true
    });
    if (!bridge.has('enrollment')) throw new Failure('UNSUPPORTED', 422);
    const value = await runtime.ops.run({
      id: operationId, actor: session.account.id, resource: row.id, action: 'credential.' + action,
      input: action, correlation: request.id, execute: async () => {
        const value = await progress({
          bridge, endpoint: '/cameras/' + row.remote_id + '/rotation' + (action === 'reconcile' ? '/reconcile' : ''),
          data: { id: operationId, confirmation: true }, correlation: request.id
        });
        return { outcome: outcome(value.status), data: value, bridgeCorrelationId: value.bridgeCorrelationId };
      }
    });
    return sendOutcome({ reply, value });
  });
};
