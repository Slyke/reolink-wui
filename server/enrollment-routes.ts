import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { correlationPattern, segment } from '../shared/urls.js';
import { record } from './bridge-channels.js';
import { Failure } from './errors.js';
import { sendOutcome } from './camera-routes.js';
import { jsonResponse } from './net.js';
import { input, uuid, type Runtime } from './runtime.js';
import type { Bridge } from './bridge.js';

const object = z.strictObject;
const safeKey = z.string().regex(segment);
const cameraLogin = object({
  operationId: uuid,
  username: z.string().min(1).max(64).refine(name => name.trim().length > 0 && !/\p{Cc}/u.test(name)),
  uid: z.string().regex(/^[a-zA-Z0-9]{8,40}$/).optional(),
  confirmation: z.literal(true)
});
const cameraPassword = z.string().regex(/^[ -~]{8,31}$/);
const changePassword = cameraLogin.extend({ password: cameraPassword });
const manageAccount = z.discriminatedUnion('action', [
  cameraLogin.extend({ action: z.literal('add'), role: z.enum(['user','administrator']), password: cameraPassword }),
  cameraLogin.extend({ action: z.literal('remove') })
]);
const states = [
  'waiting', 'identity-mismatch', 'local-setup-required', 'recovery-required', 'verified', 'restart-required',
  'active', 'previous-credential-valid', 'not-started', 'in-progress'
];
const shape = ({ response, body }: { response: Response; body: unknown }) => {
  const raw = record(body);
  const status = typeof raw.status === 'string' && states.includes(raw.status) ? raw.status : undefined;
  if (!response.ok && raw.errorKey === 'API_CAMERA_ACCOUNT_REJECTED') throw new Failure('CAMERA_ACCOUNT_REJECTED', 422);
  if (response.status === 405) throw new Failure('UNSUPPORTED', 422);
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
  const progress = async ({ bridge, endpoint, stableId, data, correlation }: {
    bridge: Bridge; endpoint: string; stableId?: string; data?: unknown; correlation: string
  }) => {
    const response = await bridge.api({ path: endpoint, stableId, data, method: data === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(65_000), correlation });
    const value = shape({ response, body: await jsonResponse({ response }) });
    let cameraId: string | undefined;
    const stable = value.remote && bridge.stableId(value.remote);
    if (stable) {
      await runtime.sync();
      const [row] = await runtime.sql.query<{ id: string }>('SELECT id FROM cameras WHERE bridge_id=$1 AND remote_id=$2', bridge.config.id,stable);
      cameraId = row?.id;
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
    const response = await bridge.api({ path: '/enrollment-targets', correlation: request.id });
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

  const users = path + '/cameras/:id/users';
  api.get<{ Params: { id: string } }>(users, async request => {
    const { bridge, row } = await runtime.camera({ request, id: request.params.id, permission: 'device.rotate' });
    if (!bridge.hasUsers(row.routeId)) throw new Failure('UNSUPPORTED', 422);
    const response = await bridge.api({ stableId: row.remote_id, path: '/cameras/' + row.routeId + '/users', correlation: request.id, signal: AbortSignal.timeout(22_000) });
    const data = record(await jsonResponse({ response }));
    if (!response.ok || !Array.isArray(data.users)) throw new Failure('BRIDGE_UNAVAILABLE', 502);
    return { writable: data.writable === true, manageAccounts: data.writable === true && data.manageAccounts === true, requiresUid: data.requiresUid === true, users: data.users.slice(0,32).flatMap(raw => {
      const user = record(raw);
      return typeof user.username === 'string' && user.username.length > 0 && user.username.length <= 64
        ? [{ username: user.username, administrator: user.administrator === true, bridgeLogin: user.bridge_login === true }] : [];
    }) };
  });
  type UserRequest = FastifyRequest<{ Params: { id: string } }>;
  const writeAccount = async (request: UserRequest, reply: FastifyReply, change: boolean) => {
    const { bridge, row, session } = await runtime.camera({ request, id: request.params.id, permission: 'device.rotate', mutate: true });
    if (!bridge.hasUsers(row.routeId) || !bridge.config.http) throw new Failure('UNSUPPORTED', 422);
    const data = change ? input({ schema: changePassword, value: request.body }) : input({ schema: manageAccount, value: request.body });
    const { operationId, ...intent } = data;
    const action = 'action' in data ? data.action : 'password';
    const fingerprintInput = 'action' in data ? data : [operationId, data.username, data.uid, data.password];
    const fingerprint = createHmac('sha256', bridge.config.http.token).update(JSON.stringify(fingerprintInput)).digest('hex');
    const value = await runtime.ops.run({
      id: operationId, actor: session.account.id, resource: row.id, action: 'camera.user.' + action, correlation: request.id, input: fingerprint,
      execute: async () => {
        const result = await progress({ bridge, stableId: row.remote_id, endpoint: '/cameras/' + row.routeId + (change ? '/users/password' : '/users'),
          data: { id: operationId, ...intent }, correlation: request.id });
        return { outcome: result.status === 'previous-credential-valid' ? 'rejected' : outcome(result.status), data: result, bridgeCorrelationId: result.bridgeCorrelationId };
      }
    });
    return sendOutcome({ reply, value });
  };
  api.post<{ Params: { id: string } }>(users, (request, reply) => writeAccount(request, reply, false));
  api.post<{ Params: { id: string } }>(users + '/password', (request, reply) => writeAccount(request, reply, true));

  const cameras = path + '/cameras/:id/rotation';
  api.get<{ Params: { id: string } }>(cameras, async request => {
    const { bridge, row } = await runtime.camera({ request, id: request.params.id, permission: 'device.rotate' });
    if (!bridge.has('enrollment')) throw new Failure('UNSUPPORTED', 422);
    return progress({ bridge, stableId: row.remote_id, endpoint: '/cameras/' + row.routeId + '/rotation', correlation: request.id });
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
          bridge, stableId: row.remote_id, endpoint: '/cameras/' + row.routeId + '/rotation' + (action === 'reconcile' ? '/reconcile' : ''),
          data: { id: operationId, confirmation: true }, correlation: request.id
        });
        return { outcome: action === 'reconcile' && value.status === 'not-started' ? 'confirmed' : outcome(value.status), data: value, bridgeCorrelationId: value.bridgeCorrelationId };
      }
    });
    return sendOutcome({ reply, value });
  });
};
