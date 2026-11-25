import { randomUUID } from 'node:crypto';
import type { ServerOptions } from 'node:https';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import { wirePath, type Config } from './config.js';
import { openDb } from './db.js';
import { correlationPattern } from '../shared/urls.js';
import { forwardProofHeader, samePeer, sameSecret } from './trusted-proxy.js';
import { classifyLegacyIdentities } from './identities.js';
import { csrfToken } from './auth.js';
import { buildInfo, configureLogging, Failure, report } from './errors.js';
import { Runtime, input, username, uuid } from './runtime.js';
import { retentionRoutes } from './retention-routes.js';
import { recordingRoutes } from './recording-routes.js';
import { liveRoutes } from './live.js';
import { encodingRoutes } from './encoding-routes.js';
import { firmwareRoutes } from './firmware-routes.js';
import { clockRoutes } from './clock-routes.js';
import { talkRoutes } from './talk-routes.js';
import { ftpRoutes } from './ftp-routes.js';
import { deviceOptionsRoutes } from './device-options-routes.js';
import { displayRoutes } from './display-routes.js';
import { networkRoutes } from './network-routes.js';
import { cameraRoutes } from './camera-routes.js';
import { adminRoutes } from './admin-routes.js';
import { bridgeSettingsRoutes } from './bridge-settings.js';
import { enrollmentRoutes } from './enrollment-routes.js';

export const api = async ({ config, tls }: { config: Config; tls?: ServerOptions }) => {
  configureLogging({ logging: config.logging });
  const sql = await openDb({ config: config.database });
  await sql.transaction(query => classifyLegacyIdentities(query, config));
  const runtime = new Runtime(config, sql);
  try {
    await runtime.start();
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const app = Fastify({
    logger: false, requestIdHeader: false, bodyLimit: 32_768,
    requestTimeout: 15_000, connectionTimeout: 0,
    genReqId: req => {
      const client = req.headers['x-correlation-id'];
      const proof = req.headers[forwardProofHeader];
      const forward = config.forward;
      return typeof client === 'string' && correlationPattern.test(client) && forward
        && typeof proof === 'string' && sameSecret({ supplied: proof, expected: forward.secret })
        && samePeer({ address: req.socket.remoteAddress, peers: forward.peers }) ? client : randomUUID();
    },
    ...(tls ? { https: tls } : {})
  } as FastifyServerOptions) as FastifyInstance;
  const path = wirePath({ config }) + '/v1';

  app.addHook('onClose', async () => { await runtime.close(); });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id)
      .header('cache-control', 'no-store, private')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer');
    if (config.httpApi.mode === 'proxy' && !['/livez', '/readyz'].includes(request.url) && !runtime.auth.forwarded({ request })) {
      throw new Failure('ACCESS_DENIED', 403);
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const failure = error instanceof Failure ? error : (
      typeof (error as { statusCode?: number })?.statusCode === 'number' && (error as { statusCode: number }).statusCode < 500
        ? new Failure('BAD_INPUT', (error as { statusCode: number }).statusCode)
        : new Failure('INTERNAL', 500)
    );
    return reply.code(failure.status).send(report({ error: failure, correlationId: request.id }));
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send(report({ error: new Failure('BAD_INPUT', 404), correlationId: request.id })));

  app.get('/livez', async request => ({ ...buildInfo, ok: true, correlationId: request.id }));
  app.get('/readyz', async (request, reply) => {
    const ok = await runtime.ready();
    if (!ok) report({ error: new Failure('BRIDGE_UNAVAILABLE',500), correlationId:request.id, caller:'api::readiness' });
    return reply.code(ok ? 200 : 500).send({ ...buildInfo, ok, correlationId: request.id });
  });

  app.get(path + '/session', async request => {
    const session = await runtime.auth.session({ request });
    return {
      methods: runtime.auth.methods({ request }),
      ...(session ? { user: { id: session.account.id, label: session.account.label, admin: session.account.admin === 1 }, csrf: csrfToken({ token: session.token }) } : {})
    };
  });
  app.post(path + '/session/local', async (request, reply) => {
    const data = input({ schema: z.strictObject({ username, password: z.string().min(1).max(512) }), value: request.body });
    return runtime.auth.local({ request, reply, ...data });
  });
  app.post(path + '/session/proxy', (request, reply) => runtime.auth.proxy({ request, reply }));
  app.get(path + '/session/oidc/start', (request, reply) => runtime.auth.oidcStart({ request, reply }));
  app.get(path + '/session/oidc/callback', (request, reply) => runtime.auth.oidcFinish({ request, reply }));
  app.delete(path + '/session', async (request, reply) => {
    await runtime.auth.logout({ request, reply });
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>(path + '/operations/:id', async request => {
    const { account } = await runtime.auth.require({ request });
    return runtime.ops.status({ id: input({ schema: uuid, value: request.params.id }), actor: account.id });
  });

  app.get(path + '/appearance-defaults', async () => {
    const { appearanceDefaults } = await runtime.settings();
    return { appearance: appearanceDefaults };
  });

  app.get(path + '/status', async request => {
    const { account } = await runtime.auth.require({ request });
    return { upstreams: await runtime.upstreams({ account }) };
  });

  cameraRoutes({ api: app, path, runtime });
  networkRoutes({ api: app, path, runtime });
  deviceOptionsRoutes({ api: app, path, runtime });
  talkRoutes({ api: app, path, runtime });
  ftpRoutes({ api: app, path, runtime });
  displayRoutes({ api: app, path, runtime });
  encodingRoutes({ api: app, path, runtime });
  clockRoutes({ api: app, path, runtime });
  firmwareRoutes({ api: app, path, runtime });
  adminRoutes({ api: app, path, runtime });
  bridgeSettingsRoutes({ api: app, path, runtime });
  enrollmentRoutes({ api: app, path, runtime });
  liveRoutes({ api: app, path, runtime });
  recordingRoutes({ api: app, path, runtime });
  retentionRoutes({ api: app, path, runtime });

  return { app, runtime };
};
