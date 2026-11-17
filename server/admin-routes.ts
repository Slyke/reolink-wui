import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { segment } from '../shared/urls.js';
import { maxEventRetention } from '../shared/events.js';
import { palettes, modes, fonts, widths } from '../shared/appearance.js';
import { minInventoryIntervalSeconds, maxInventoryIntervalSeconds } from '../shared/upstreams.js';
import { permissions, presets, type Permission } from '../shared/access.js';
import { audit, type CameraRef } from './db.js';
import { passwordHash, isLocal } from './auth.js';
import { input, password, shortLabel, username, uuid, type Runtime } from './runtime.js';
import { Failure } from './errors.js';
import { information } from './cameras.js';
import { result } from './bridge.js';
import { record } from './bridge-channels.js';
import { sendOutcome } from './camera-routes.js';

const object = z.strictObject;
const operationId = uuid;
const key = z.string().regex(segment);
const external = object({ subject: z.string().regex(/^[^\x00-\x20\x7f,]{1,180}$/) });

export const identityIssuer = ({ config }: { config: Runtime['config'] }) => {
  if ('ingress' in config.auth) return config.auth.ingress.issuer;
  if ('oidc' in config.auth) {
    return config.auth.oidc.issuer.href;
  }
  throw new Failure('UNSUPPORTED', 422);
};

export const adminRoutes = ({ api, path, runtime }: { api: FastifyInstance; path: string; runtime: Runtime }) => {
  const root = path + '/admin';
  const getBridge = ({ id }: { id: string }) => {
    const bridge = runtime.bridges.get(id);
    if (!bridge) throw new Failure('BAD_INPUT', 404);
    return bridge;
  };
  api.get(root, async request => {
    await runtime.admin({ request });
    await runtime.sync();
    const [cameras, accounts, grants, bridgeRows, settings] = await Promise.all([
      runtime.sql.query<CameraRef>('SELECT * FROM cameras ORDER BY bridge_id,remote_id'),
      runtime.sql.query('SELECT id,label,username,admin,enabled FROM accounts ORDER BY label'),
      runtime.sql.query<{ account_id: string; camera_id: string; permissions: string }>('SELECT g.* FROM grants g JOIN accounts a ON a.id=g.account_id WHERE a.admin=0 ORDER BY g.account_id,g.camera_id'),
      runtime.sql.query<{ id: string; refreshed_at: string | null }>('SELECT id,refreshed_at FROM bridges'),
      runtime.settings()
    ]);
    return {
      ...settings,
      accounts, grants: grants.map(row => ({ ...row, permissions: JSON.parse(row.permissions) })),
      permissions, presets, external: runtime.config.auth.mode !== 'local', local: isLocal({ config: runtime.config }),
      bridges: [...runtime.bridges.values()].map(bridge => ({
        id: bridge.config.id, label: bridge.config.label, connected: bridge.feedReady,
        refreshedAt: bridgeRows.find(row => row.id === bridge.config.id)?.refreshed_at,
        enrollment: bridge.has('enrollment'), callbacks: !!bridge.config.callbacks
      })),
      cameras: cameras.flatMap(row => {
        const bridge = runtime.bridges.get(row.bridge_id);
        return bridge?.includes(row.remote_id)
          ? [{ id: row.id, bridge: row.bridge_id, label: information({ state: bridge.state(row.remote_id) }).name ?? row.remote_id }]
          : [];
      })
    };
  });

  api.get(root + '/event-history', async request => {
    await runtime.admin({ request });
    return runtime.history.settings();
  });
  api.put(root + '/appearance-defaults', async (request, reply) => {
    const { account } = await runtime.admin({ request, mutate: true });
    const { operationId: id, appearance } = input({
      schema: object({ operationId, appearance: object({
        palette: z.enum(palettes), theme: z.enum(modes), font: z.enum(fonts), contentWidth: z.enum(widths)
      }) }), value: request.body
    });
    const result = await runtime.ops.run({
      id, actor: account.id, action: 'appearance.defaults', resource: 'appearance', correlation: request.id,
      input: appearance, execute: async () => {
        await runtime.sql.query('UPDATE instance_settings SET appearance=$1 WHERE id=1', JSON.stringify(appearance));
        return { outcome: 'confirmed', data: { appearance } };
      }
    });
    return sendOutcome({ reply, value: result });
  });

  api.put(root + '/inventory-settings', async (request, reply) => {
    const { account } = await runtime.admin({ request, mutate: true });
    const { operationId: id, intervalSeconds } = input({
      schema: object({ operationId, intervalSeconds: z.number().int().min(minInventoryIntervalSeconds).max(maxInventoryIntervalSeconds) }),
      value: request.body
    });
    const result = await runtime.ops.run({
      id, actor: account.id, action: 'inventory.interval', resource: 'inventory', correlation: request.id,
      input: intervalSeconds, execute: async () => {
        await runtime.setInventoryInterval({ seconds: intervalSeconds });
        return { outcome: 'confirmed', data: { intervalSeconds } };
      }
    });
    return sendOutcome({ reply, value: result });
  });

  api.put(root + '/event-history', async (request, reply) => {
    const admin = await runtime.admin({ request, mutate: true });
    const { operationId: id, limit } = input({
      schema: object({ operationId, limit: z.number().int().min(0).max(maxEventRetention) }), value: request.body
    });
    const value = await runtime.ops.run({
      id, actor: admin.account.id, action: 'event-history.resize', resource: 'event-history',
      input: limit, correlation: request.id, execute: async () => {
        await runtime.history.setLimit({ limit });
        return { outcome: 'confirmed', data: await runtime.history.settings() };
      }
    });
    return sendOutcome({ reply, value });
  });

  api.post(root + '/accounts', async (request, reply) => {
    const admin = await runtime.admin({ request, mutate: true });
    const data = input({
      schema: object({ operationId, label: shortLabel, local: object({ username, password }).optional(), identity: external.optional() })
        .refine(data => data.local || data.identity),
      value: request.body
    });
    if (data.local && !isLocal({ config: runtime.config })) throw new Failure('UNSUPPORTED', 422);
    const value = await runtime.ops.run({
      id: data.operationId, actor: admin.account.id, action: 'account.create', resource: 'accounts',
      correlation: request.id, input: { label: data.label, username: data.local?.username, subject: data.identity?.subject },
      execute: async () => {
        const encoded = data.local ? await passwordHash({ password: data.local.password }) : null;
        const id = randomUUID();
        await runtime.sql.transaction(async query => {
          const inserted = await query('INSERT INTO accounts(id,label,username,password_hash,admin,enabled) VALUES ($1,$2,$3,$4,0,1) ON CONFLICT DO NOTHING RETURNING id',
            id, data.label, data.local?.username ?? null, encoded);
          if (!inserted.length) throw new Failure('OPERATION_CONFLICT', 409);
          if (data.identity) {
            const linked = await query('INSERT INTO identities(issuer,subject,account_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING account_id',
              identityIssuer({ config: runtime.config }), data.identity.subject, id);
            if (!linked.length) throw new Failure('IDENTITY_MISMATCH', 409);
          }
        });
        return { outcome: 'confirmed', data: { id } };
      }
    });
    return sendOutcome({ reply, value });
  });

  api.post<{ Params: { id: string } }>(root + '/accounts/:id/identities', async (request, reply) => {
    const admin = await runtime.admin({ request, mutate: true });
    const id = input({ schema: uuid, value: request.params.id });
    const data = input({ schema: object({ operationId, identity: external }), value: request.body });
    const issuer = identityIssuer({ config: runtime.config });
    const value = await runtime.ops.run({
      id: data.operationId, actor: admin.account.id, action: 'identity.link', resource: id,
      input: [issuer, data.identity.subject], correlation: request.id,
      execute: async () => {
        await runtime.sql.transaction(async query => {
          if (!(await query('SELECT id FROM accounts WHERE id=$1', id)).length) throw new Failure('ACCESS_DENIED', 403);
          const [linked] = await query<{ account_id: string }>(
            'INSERT INTO identities(issuer,subject,account_id) VALUES ($1,$2,$3) ON CONFLICT (issuer,subject) DO UPDATE SET subject=excluded.subject RETURNING account_id',
            issuer, data.identity.subject, id
          );
          if (linked.account_id !== id) throw new Failure('IDENTITY_MISMATCH', 409);
        });
        return { outcome: 'confirmed' };
      }
    });
    return sendOutcome({ reply, value });
  });

  api.patch<{ Params: { id: string } }>(root + '/accounts/:id', async (request, reply) => {
    const admin = await runtime.admin({ request, mutate: true });
    const id = input({ schema: uuid, value: request.params.id });
    if (id === admin.account.id) throw new Failure('ACCESS_DENIED', 403);
    const data = input({ schema: object({ operationId, enabled: z.boolean(), confirmation: z.literal(true) }), value: request.body });
    const value = await runtime.ops.run({
      id: data.operationId, actor: admin.account.id, action: 'account.access', resource: id, input: data.enabled, correlation: request.id,
      execute: async () => {
        await runtime.sql.transaction(async query => {
          const account = await query('UPDATE accounts SET enabled=$1 WHERE id=$2 AND admin=0 RETURNING id', Number(data.enabled), id);
          if (!account.length) throw new Failure('ACCESS_DENIED', 403);
          if (!data.enabled) await query('DELETE FROM sessions WHERE account_id=$1', id);
        });
        return { outcome: 'confirmed' };
      }
    });
    return sendOutcome({ reply, value });
  });

  api.put<{ Params: { id: string; camera: string } }>(root + '/accounts/:id/grants/:camera', async (request, reply) => {
    const admin = await runtime.admin({ request, mutate: true });
    const id = input({ schema: uuid, value: request.params.id });
    const camera = input({ schema: uuid, value: request.params.camera });
    const data = input({
      schema: object({
        operationId, preset: z.enum(['none', 'viewer', 'operator', 'camera-admin']), allow: z.array(z.enum(permissions)).max(permissions.length),
        deny: z.array(z.enum(permissions)).max(permissions.length)
      }).refine(data => !data.allow.some(item => data.deny.includes(item))),
      value: request.body
    });
    const newGrants = new Set<Permission>(data.preset === 'none' ? [] : presets[data.preset]);
    data.allow.forEach(item => newGrants.add(item));
    data.deny.forEach(item => newGrants.delete(item));
    const granted = [...newGrants].sort();
    const value = await runtime.ops.run({
      id: data.operationId, actor: admin.account.id, action: 'grant.update', resource: camera, input: [id, granted], correlation: request.id,
      execute: async () => {
        await runtime.sql.transaction(async query => {
          const [account] = await query<{ admin: number }>('SELECT admin FROM accounts WHERE id=$1', id);
          if (account?.admin === 1) throw new Failure('ACCESS_DENIED', 403);
          const [row] = await query<CameraRef>('SELECT * FROM cameras WHERE id=$1', camera);
          if (!account || !row || !runtime.bridges.get(row.bridge_id)?.includes(row.remote_id)) throw new Failure('BAD_INPUT', 404);
          if (!granted.length) {
            await query('DELETE FROM grants WHERE account_id=$1 AND camera_id=$2', id, camera);
          } else {
            await query(
              'INSERT INTO grants(account_id,camera_id,permissions) VALUES ($1,$2,$3) ON CONFLICT (account_id,camera_id) DO UPDATE SET permissions=excluded.permissions',
              id, camera, JSON.stringify(granted)
            );
          }
        });
        return { outcome: 'confirmed', data: { permissions: granted } };
      }
    });
    return sendOutcome({ reply, value });
  });

  api.post<{ Params: { bridge: string } }>(root + '/bridges/:bridge/sync', async (request, reply) => {
    const admin = await runtime.admin({ request, mutate: true });
    const bridge = getBridge({ id: request.params.bridge });
    const { operationId: id } = input({ schema: object({ operationId }), value: request.body });
    const value = await runtime.ops.run({
      id, actor: admin.account.id, action: 'bridge.sync', resource: 'bridge:' + bridge.config.id,
      input: null, correlation: request.id,
      execute: async () => {
        await bridge.refreshInventory();
        await runtime.sync();
        const refreshedAt = new Date().toISOString();
        await runtime.sql.query('UPDATE bridges SET refreshed_at=$1 WHERE id=$2', refreshedAt, bridge.config.id);
        return { outcome: 'confirmed', data: { refreshedAt } };
      }
    });
    return sendOutcome({ reply, value });
  });

  const callbackData = (callbacks: unknown, mapping: Map<string,string>) => (
    Array.isArray(callbacks) ? callbacks.slice(0, 64).map(value => {
      const item = record(value);
      let url = 'Stored privately';
      try {
        const parsed = new URL(String(item.url));
        if (['http:', 'https:'].includes(parsed.protocol)) url = parsed.origin;
      } catch { /* A reference supplied by the bridge is kept private. */ }
      return {
        id: typeof item.id === 'string' && segment.test(item.id) ? item.id : '',
        destination: url,
        cameras: Array.isArray(item.cameras) ? item.cameras.map(value => mapping.get(String(value))).filter(Boolean) : [],
        events: Array.isArray(item.events) ? item.events.filter(value => typeof value === 'string' && /^[\w:/-]{1,128}$/.test(value)).slice(0, 32) : []
      };
    }).filter(item => item.id) : []
  );

  const cameraMapping = async (bridgeId: string) => new Map((await runtime.sql.query<CameraRef>('SELECT * FROM cameras WHERE bridge_id=$1', bridgeId)).map(row => [row.remote_id, row.id]));

  api.get<{ Params: { bridge: string } }>(root + '/bridges/:bridge/callbacks', async request => {
    await runtime.admin({ request });
    const bridge = getBridge({ id: request.params.bridge });
    const before = Date.now();
    const response = await bridge.callbacks({ id: randomUUID(), op: 'callbacks_list' });
    if (!response.ok) throw new Failure('COMMAND_REJECTED', 422);
    await runtime.ops.reconcile({ camera: 'bridge:' + bridge.config.id, group: 'callbacks', before });
    return { callbacks: callbackData(response.callbacks, await cameraMapping(bridge.config.id)), destinations: Object.keys(bridge.config.callbacks ?? {}) };
  });
  api.post<{ Params: { bridge: string } }>(root + '/bridges/:bridge/callbacks', async (request, reply) => {
    const admin = await runtime.admin({ request, mutate: true });
    const bridge = getBridge({ id: request.params.bridge });
    const body = input({
      schema: z.discriminatedUnion('action', [
        object({ operationId, action: z.literal('remove'), id: key, confirmation: z.literal(true) }),
        object({ operationId, action: z.enum(['add', 'update']), id: key, destination: key,
          cameras: z.array(uuid).max(64), events: z.array(z.string().regex(/^[\w:/-]{1,128}$/)).max(32) })
      ]), value: request.body
    });
    const value = await runtime.ops.run({
      id: body.operationId, actor: admin.account.id, action: 'callback.' + body.action, resource: 'bridge:' + bridge.config.id,
      input: body, correlation: request.id, serialized: true, reconcileGroup: 'callbacks', execute: async () => {
        let command: Parameters<typeof bridge.callbacks>[0];
        if (body.action === 'remove') {
          command = { id: body.operationId, op: 'callbacks_remove', callback_id: body.id };
        } else {
          const destination = bridge.config.callbacks?.[body.destination];
          if (!(destination instanceof URL)) throw new Failure('CALLBACK_INVALID', 422);
          const cameras: string[] = [];
          for (const id of new Set(body.cameras)) {
            const [row] = await runtime.sql.query<CameraRef>('SELECT * FROM cameras WHERE id=$1 AND bridge_id=$2', id, bridge.config.id);
            if (!row || !bridge.includes(row.remote_id)) throw new Failure('CALLBACK_INVALID', 422);
            cameras.push(row.remote_id);
          }
          command = {
            id: body.operationId, op: 'callbacks_' + body.action,
            callback: { id: body.id, url: destination.href, cameras, events: [...new Set(body.events)] }
          };
        }
        const response = await bridge.callbacks(command);
        return { ...result({ reply: response, write: true }), data: response.ok ? callbackData(response.callbacks, await cameraMapping(bridge.config.id)) : undefined };
      }
    });
    return sendOutcome({ reply, value });
  });

  api.get(root + '/audit', async (request: FastifyRequest) => {
    await runtime.admin({ request });
    return { entries: await runtime.sql.query(
      'SELECT actor,resource,action,outcome,operation,correlation,bridge_correlation,created FROM audit ORDER BY created DESC LIMIT 100'
    ) };
  });
};
