import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { z as schema } from 'zod';
import { Bridge } from './bridge.js';
import type { Config } from './config.js';
import { camerasFor, storeCamera, type Account, type CameraRef, type Sql } from './db.js';
import { Auth } from './auth.js';
import { Operations } from './operations.js';
import { Failure } from './errors.js';
import { available, capabilities, information } from './cameras.js';
import type { Permission } from '../shared/access.js';
import { defaultInventoryIntervalSeconds, type InventoryState } from '../shared/upstreams.js';
import { EventHistory } from './event-history.js';
import { appearanceOverrides, defaultAppearance } from '../shared/appearance.js';

export const uuid = schema.uuid({ version: 'v4' });
export const shortLabel = schema.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/);
export const username = schema.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{2,63}$/);
export const password = schema.string().min(12).max(512);
export const input = <T extends z.ZodType>({ schema, value }: { schema: T; value: unknown }): z.infer<T> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Failure('BAD_INPUT', 400);
  return parsed.data;
};

export class Runtime {
  readonly bridges: Map<string, Bridge>;
  readonly auth: Auth;
  readonly ops: Operations;
  readonly history: EventHistory;
  private readonly eventObservers: (() => void)[] = [];
  private checking?: Promise<boolean>;
  private monitor?: ReturnType<typeof setInterval>;
  private inventoryInterval = defaultInventoryIntervalSeconds;
  private inventoryTask?: Promise<void>;
  private inventoryUpdates = Promise.resolve();
  private closing = false;

  constructor(readonly config: Config, readonly sql: Sql) {
    this.bridges = new Map(config.bridges.map(item => [item.id, new Bridge(item)]));
    this.auth = new Auth(config, sql);
    this.ops = new Operations(sql);
    this.history = new EventHistory(config.eventHistory, sql);
  }

  async start() {
    await this.history.start();
    for (const bridge of this.bridges.values()) {
      const id = bridge.config.id;
      await this.sql.query('INSERT INTO bridges(id) VALUES ($1) ON CONFLICT DO NOTHING', id);
      this.eventObservers.push(bridge.observe(update => {
        if (update.kind === 'event' && bridge.ids().includes(update.camera)) {
          this.history.add({ camera: id + '/' + update.camera, entry: update.entry });
        }
      }));
    }
    await this.sync();
    const { inventoryIntervalSeconds } = await this.settings();
    this.scheduleInventory({ seconds: inventoryIntervalSeconds });
    this.pollInventory();
  }

  async sync() {
    const existing = await this.sql.query<CameraRef>('SELECT * FROM cameras');
    const known = new Set(existing.map(camera => camera.bridge_id + '/' + camera.remote_id));
    for (const bridge of this.bridges.values()) {
      for (const id of bridge.ids()) {
        if (!known.has(bridge.config.id + '/' + id)) await storeCamera({ sql: this.sql, bridge: bridge.config.id, remote: id });
      }
    }
  }

  async settings() {
    const [row] = await this.sql.query<{ appearance: string; inventory_interval_seconds: number }>(
      'SELECT appearance,inventory_interval_seconds FROM instance_settings WHERE id=1'
    );
    return {
      appearanceDefaults: { ...defaultAppearance, ...appearanceOverrides(JSON.parse(row.appearance)) },
      inventoryIntervalSeconds: row.inventory_interval_seconds
    };
  }

  setInventoryInterval({ seconds }: { seconds: number }) {
    const change = this.inventoryUpdates.then(async () => {
      await this.sql.query('UPDATE instance_settings SET inventory_interval_seconds=$1 WHERE id=1', seconds);
      this.scheduleInventory({ seconds });
    });
    this.inventoryUpdates = change.catch(() => {});
    return change;
  }

  private scheduleInventory({ seconds }: { seconds: number }) {
    if (this.closing || (this.monitor && this.inventoryInterval === seconds)) return;
    this.inventoryInterval = seconds;
    clearInterval(this.monitor);
    this.monitor = setInterval(this.pollInventory, seconds * 1000);
    this.monitor.unref();
  }

  private pollInventory = () => {
    if (this.closing || this.inventoryTask) return;
    this.inventoryTask = this.ready().then(async () => {
      await Promise.allSettled([...this.bridges.values()].map(bridge => bridge.scanInventory()));
      await this.sync();
    }).catch(() => {}).finally(() => { this.inventoryTask = undefined; });
  };

  inventoryState(): InventoryState {
    if (this.bridges.size === 0) return 'no-bridge';
    if ([...this.bridges.values()].some(bridge => bridge.ids().length > 0)) return 'discovered';
    return [...this.bridges.values()].some(bridge => bridge.feedReady) ? 'empty' : 'waiting';
  }

  async upstreams({ account }: { account: Account }) {
    await this.ready();
    if (account.admin === 1) return [...this.bridges.values()].map(bridge => bridge.upstream());
    const rows = await camerasFor({ sql: this.sql, account });
    const visible = new Set<string>();
    for (const row of rows) {
      if (row.permissions.includes('view') && this.bridges.get(row.bridge_id)?.includes(row.remote_id)) {
        visible.add(row.bridge_id);
      }
    }
    return [...this.bridges.values()].filter(bridge => visible.has(bridge.config.id)).map(bridge => bridge.upstream());
  }

  ready() {
    const updates = this.inventoryUpdates;
    this.checking ??= Promise.all([
      this.sql.query<{ inventory_interval_seconds: number }>('SELECT inventory_interval_seconds FROM instance_settings WHERE id=1')
        .then(([row]) => {
          if (row && this.inventoryUpdates === updates) this.scheduleInventory({ seconds: row.inventory_interval_seconds });
          return !!row;
        }, () => false),
      this.auth.ready(), ...[...this.bridges.values()].map(bridge => bridge.check().catch(() => false))
    ]).then(items => items.every(Boolean)).finally(() => { this.checking = undefined; });
    return this.checking;
  }

  async close() {
    this.closing = true;
    clearInterval(this.monitor);
    await Promise.all([this.inventoryTask, this.inventoryUpdates]);
    this.eventObservers.forEach(stop => stop());
    this.history.close();
    return Promise.all([...this.bridges.values()].map(bridge => bridge.close()).concat([this.sql.close(), Promise.resolve(this.auth.close()).then(() => undefined)]));
  }

  async admin({ request, mutate = false }: { request: FastifyRequest; mutate?: boolean }) {
    const session = await this.auth.require({ request, mutate });
    if (session.account.admin !== 1) throw new Failure('ACCESS_DENIED', 403);
    return session;
  }

  async camera({ request, id, permission, mutate = false }: {
    request: FastifyRequest; id: string; permission: Permission; mutate?: boolean
  }) {
    const session = await this.auth.require({ request, mutate });
    const [row] = await camerasFor({ sql: this.sql, account: session.account, id: input({ schema: uuid, value: id }) });
    const grant = new Set(row?.permissions);
    if (!row || !grant.has(permission)) throw new Failure('ACCESS_DENIED', 403);
    const bridge = this.bridges.get(row.bridge_id);
    if (!bridge || !bridge.includes(row.remote_id)) throw new Failure('CAMERA_UNKNOWN', 404);
    return { row, grant, bridge, session };
  }

  async views({ account }: { account: Account }) {
    await this.sync();
    const rows = await camerasFor({ sql: this.sql, account });
    return rows.flatMap(row => {
      const bridge = this.bridges.get(row.bridge_id);
      const grant = new Set(row.permissions);
      if (!bridge?.includes(row.remote_id) || !grant.has('view')) return [];
      return [{
        id: row.id, ...information({ state: bridge.state(row.remote_id) }),
        availability: available({ bridge, remote: row.remote_id }),
        previewIntervalMs: row.preview_interval_ms, refreshOnAlert: row.preview_refresh_on_alert,
        capabilities: capabilities({ bridge, remote: row.remote_id, grant, proxy: !!row.rtsp_proxy })
      }];
    });
  }
}
