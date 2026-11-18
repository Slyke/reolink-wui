import { Redis } from 'ioredis';
import type { CameraEvent } from './cameras.js';
import { historyStorageSchema, type HistoryConfig, type HistoryStorage, type HistoryStorageInput, type HistorySettings, type Valkey } from '../shared/history.js';
import type { Sql } from './db.js';
import { Failure } from './errors.js';
import { maxEventRetention } from '../shared/events.js';

const addEvent = `
local keep = tonumber(ARGV[1])
if keep > 0 then
  redis.call('SADD', KEYS[1], KEYS[2])
  redis.call('LPUSH', KEYS[2], ARGV[2])
  redis.call('LTRIM', KEYS[2], 0, keep - 1)
end
`;

const readEvents = `
local keep = tonumber(ARGV[1])
if keep == 0 then return {keep, {}} end
return {keep, redis.call('LRANGE', KEYS[1], 0, keep - 1)}
`;

const resize = `
if redis.call('SCARD', KEYS[2]) ~= #KEYS - 2 then return 0 end
for i = 3, #KEYS do
  if redis.call('SISMEMBER', KEYS[2], KEYS[i]) == 0 then return 0 end
end
local keep = tonumber(ARGV[1])
for i = 3, #KEYS do
  if keep == 0 then redis.call('DEL', KEYS[i])
  else redis.call('LTRIM', KEYS[i], 0, keep - 1) end
end
if keep == 0 then redis.call('DEL', KEYS[2]) end
redis.call('SET', KEYS[1], keep)
return 1
`;

const unavailable = () => new Failure('EVENT_HISTORY_UNAVAILABLE', 503);

class HistoryCache {
  private readonly memory = new Map<string, CameraEvent[]>();
  private readonly client?: Redis;
  private readonly prefix: string;
  private pending = 0;
  private initializing = true;
  limit: number;

  constructor(private readonly config: HistoryConfig) {
    this.limit = config.retention;
    this.prefix = config.backend === 'valkey' ? config.keyPrefix + ':events:' : '';
    if (config.backend === 'valkey') {
      this.client = new Redis(config.url.href, {
        ...(config.url.protocol === 'rediss:' ? { tls: { ca: config.ca, rejectUnauthorized: true } } : {}),
        lazyConnect: true, connectTimeout: 2000, commandTimeout: 2000, enableReadyCheck: false,
        enableOfflineQueue: false, autoResendUnfulfilledCommands: false, maxRetriesPerRequest: 0,
        retryStrategy: () => 1500
      });
      this.client.on('error', () => {});
      this.client.on('ready', () => { if (!this.initializing) void this.resize().catch(() => {}); });
    }
  }

  get connected() { return !this.client || this.client.status === 'ready'; }
  private get settingKey() { return this.prefix + 'limit'; }
  private get indexKey() { return this.prefix + 'cameras'; }
  private eventKey(camera: string) { return this.prefix + 'camera:' + camera; }

  async start(importLimit = false) {
    if (this.client) {
      await this.client.connect().catch(() => {});
      if (importLimit && this.connected) {
        const stored = await this.client.get(this.settingKey).catch(() => null);
        const count = stored === null ? NaN : Number(stored);
        if (Number.isInteger(count) && count >= 0 && count <= maxEventRetention) this.limit = count;
      }
    }
    this.initializing = false;
    await this.resize().catch(() => {});
  }

  private async resize() {
    if (!this.client || !this.connected) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      const cameras = await this.client.smembers(this.indexKey);
      if (await this.client.eval(resize, cameras.length + 2, this.settingKey, this.indexKey, ...cameras, this.limit) === 1) return;
    }
    throw unavailable();
  }

  async setLimit(limit: number) {
    this.limit = limit;
    if (limit === 0) this.memory.clear();
    else for (const events of this.memory.values()) events.splice(0, Math.max(0, events.length - limit));
    await this.resize().catch(() => {});
  }

  add({ camera, entry }: { camera: string; entry: CameraEvent }) {
    if (this.client) {
      if (!this.connected || this.pending >= 256 || !this.limit) return;
      this.pending++;
      void this.client.eval(addEvent, 2, this.indexKey, this.eventKey(camera),
        this.limit, JSON.stringify(entry)).catch(() => {}).finally(() => { this.pending--; });
      return;
    }
    if (!this.limit) return;
    const events = this.memory.get(camera) ?? [];
    events.push(entry);
    if (events.length > this.limit) events.shift();
    this.memory.set(camera, events);
  }

  async read(camera: string) {
    if (!this.limit) return { limit: 0, events: [] };
    if (!this.client) return { limit: this.limit, events: [...(this.memory.get(camera) ?? [])] };
    try {
      const [limit, events] = await this.client.eval(
        readEvents, 1, this.eventKey(camera), this.limit
      ) as [number, string[]];
      return { limit, events: events.reverse().map(serialized => JSON.parse(serialized) as CameraEvent) };
    } catch { throw unavailable(); }
  }

  close() { this.client?.disconnect(); this.memory.clear(); }
}

const publicValkey = (config: Valkey) => {
  const url = new URL(config.url);
  const passwordConfigured = Boolean(url.password);
  url.password = '';
  return { url: url.href, keyPrefix: config.keyPrefix, ca: config.ca, passwordConfigured };
};

export class EventHistory {
  private storage: HistoryStorage = { mode: 'defaults' };
  private cache: HistoryCache;
  private stored = '';
  private changes = Promise.resolve();

  constructor(private readonly defaults: HistoryConfig, private readonly sql: Sql) {
    this.cache = new HistoryCache({ backend: 'memory', retention: defaults.retention });
  }

  private effective(storage: HistoryStorage, retention: number): HistoryConfig {
    const selected = storage.mode === 'defaults' ? this.defaults
      : storage.mode === 'valkey' ? { ...storage.valkey, backend: 'valkey' as const } : { backend: 'memory' as const };
    return selected.backend === 'memory' ? { backend: 'memory', retention } : {
      backend: 'valkey', url: selected.url, keyPrefix: selected.keyPrefix, ca: selected.ca, retention
    };
  }

  private serialize<T>(work: () => Promise<T>) {
    const pending = this.changes.then(work);
    this.changes = pending.then(() => {}, () => {});
    return pending;
  }

  async start() {
    const [row] = await this.sql.query<{ retention: number; storage: string }>(
      'SELECT retention,storage FROM event_history_settings WHERE id=1'
    );
    this.storage = historyStorageSchema.parse(row ? JSON.parse(row.storage) : { mode: 'defaults' });
    const config = this.effective(this.storage, row?.retention ?? this.defaults.retention);
    this.cache = new HistoryCache(config);
    await this.cache.start(!row);
    await this.sql.query(
      'INSERT INTO event_history_settings(id,retention,storage) VALUES (1,$1,$2) ON CONFLICT DO NOTHING',
      this.cache.limit, JSON.stringify(this.storage)
    );
    this.stored = JSON.stringify([this.cache.limit, this.storage]);
    await this.refresh();
  }

  private async refresh() {
    const [row] = await this.sql.query<{ retention: number; storage: string }>(
      'SELECT retention,storage FROM event_history_settings WHERE id=1'
    );
    const storage = historyStorageSchema.parse(JSON.parse(row.storage));
    if (this.stored === JSON.stringify([row.retention, storage])) return;
    await this.apply(storage, row.retention);
  }

  private async apply(storage: HistoryStorage, limit: number) {
    if (JSON.stringify(this.effective(storage, limit)) === JSON.stringify(this.effective(this.storage, limit))) {
      await this.cache.setLimit(limit);
    } else {
      const next = new HistoryCache(this.effective(storage, limit));
      await next.start();
      this.cache.close();
      this.cache = next;
    }
    this.storage = storage;
    this.stored = JSON.stringify([limit, storage]);
  }

  settings(): Promise<HistorySettings> {
    return this.serialize(async () => {
      await this.refresh();
      const current = this.effective(this.storage, this.cache.limit);
      return {
        backend: current.backend, limit: this.cache.limit, connected: this.cache.connected,
        storage: {
          mode: this.storage.mode,
          ...(this.storage.valkey ? { valkey: publicValkey(this.storage.valkey) } : {})
        },
        defaults: {
          backend: this.defaults.backend,
          ...(this.defaults.backend === 'valkey' ? { valkey: publicValkey(this.defaults) } : {})
        }
      };
    });
  }

  setOptions({ limit, storage }: { limit: number; storage?: HistoryStorageInput }) {
    return this.serialize(async () => {
      const selected = await this.sql.transaction(async query => {
        const [row] = await query<{storage:string}>('SELECT storage FROM event_history_settings WHERE id=1');
        const saved = historyStorageSchema.parse(JSON.parse(row.storage));
        let selected: HistoryStorage = saved;
        if (storage?.mode === 'valkey') {
          const {password,...fields} = storage.valkey;
          const url = new URL(fields.url);
          const previous = saved.valkey ?? (this.defaults.backend === 'valkey' ? this.defaults : undefined);
          if (password !== undefined) url.password = encodeURIComponent(password);
          else if (!url.password && previous && publicValkey(previous).url === url.href) url.password = previous.url.password;
          selected = {mode:'valkey',valkey:{...fields,url}};
        } else if (storage) selected = {...storage,...(saved.valkey ? {valkey:saved.valkey} : {})};
        await query('UPDATE event_history_settings SET retention=$1,storage=$2 WHERE id=1',limit,JSON.stringify(selected));
        return selected;
      });
      await this.apply(selected,limit);
    });
  }

  setLimit({ limit }: { limit: number }) { return this.setOptions({ limit }); }
  add(entry: { camera: string; entry: CameraEvent }) { this.cache.add(entry); }
  async read({ camera }: { camera: string }) {
    const cache = await this.serialize(async () => { await this.refresh(); return this.cache; });
    return cache.read(camera);
  }
  async close() { await this.changes; this.cache.close(); }
}
