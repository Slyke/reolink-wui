import type { Redis } from 'ioredis';
import { testValkey, valkeyClient } from './valkey.js';
import type { CameraEvent } from './cameras.js';
import { historyStorageSchema, type HistoryConnectionInput, type HistoryConfig, type HistoryStorage, type HistoryStorageInput, type HistorySettings, type Valkey } from '../shared/history.js';
import type { Sql } from './db.js';
import { Failure, recordError } from './errors.js';
import { maxEventRetention } from '../shared/events.js';

// Upgrade existing list keys in place, keeping event IDs and timestamps.
const sortedEvents = `
local function insert(key, score, entry)
  local newest = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
  if newest[2] and math.floor(tonumber(newest[2])) == score then score = tonumber(newest[2]) + 0.001 end
  redis.call('ZADD', key, score, entry)
end
local function upgrade(key)
  if redis.call('TYPE', key).ok == 'list' then
    local entries = redis.call('LRANGE', key, 0, -1)
    redis.call('DEL', key)
    for i = #entries, 1, -1 do
      local value = cjson.decode(entries[i])
      insert(key, value.observedAt, entries[i])
    end
  end
end
local function trim(key, keep, age, now)
  upgrade(key)
  if age > 0 then redis.call('ZREMRANGEBYSCORE', key, '-inf', now - age * 1000) end
  if keep == 0 then redis.call('DEL', key)
  elseif keep > 0 then
    local count = redis.call('ZCARD', key)
    if count > keep then redis.call('ZREMRANGEBYRANK', key, 0, count - keep - 1) end
  end
  if age > 0 then
    local newest = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
    if newest[2] then redis.call('PEXPIREAT', key, math.floor(tonumber(newest[2]) + age * 1000)) end
  else redis.call('PERSIST', key) end
end
`;
const addEvent = sortedEvents + `
local keep, age, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
if keep ~= 0 then
  upgrade(KEYS[2])
  redis.call('SADD', KEYS[1], KEYS[2])
  insert(KEYS[2], tonumber(ARGV[5]), ARGV[4])
end
trim(KEYS[2], keep, age, now)
`;
const readEvents = sortedEvents + `
local keep, age, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
-- Consolidate confirmed former identities atomically. A second reader can safely retry.
if #KEYS > 2 then
  local sources = {KEYS[1]}
  for i = 3, #KEYS do
    if redis.call('EXISTS', KEYS[i]) == 1 then
      upgrade(KEYS[i])
      table.insert(sources, KEYS[i])
    end
  end
  if #sources > 1 then
    upgrade(KEYS[1])
    local args = {KEYS[1], #sources}
    for _, key in ipairs(sources) do table.insert(args, key) end
    table.insert(args, 'AGGREGATE')
    table.insert(args, 'MIN')
    redis.call('ZUNIONSTORE', unpack(args))
    redis.call('SADD', KEYS[2], KEYS[1])
    for i = 2, #sources do
      redis.call('DEL', sources[i])
      redis.call('SREM', KEYS[2], sources[i])
    end
  end
end
trim(KEYS[1], keep, age, now)
return {keep, redis.call('ZRANGE', KEYS[1], -tonumber(ARGV[4]), -1)}
`;
const resize = sortedEvents + `
if redis.call('SCARD', KEYS[2]) ~= #KEYS - 2 then return 0 end
for i = 3, #KEYS do
  if redis.call('SISMEMBER', KEYS[2], KEYS[i]) == 0 then return 0 end
end
local keep, age, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
for i = 3, #KEYS do
  trim(KEYS[i], keep, age, now)
  if redis.call('EXISTS', KEYS[i]) == 0 then redis.call('SREM', KEYS[2], KEYS[i]) end
end
redis.call('SET', KEYS[1], ARGV[4])
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
      this.client = valkeyClient(config, true);
      this.client.on('error', () => {
        recordError({ key:'EVENT_HISTORY_CONNECTION_FAILED',caller:'history::valkey' });
      });
      this.client.on('ready', () => { if (!this.initializing) void this.resize().catch(() => recordError({key:'EVENT_HISTORY_RETENTION_FAILED',caller:'history::resize'})); });
    }
  }

  private get countLimit() {
    return this.config.backend === 'valkey' ? (this.config.maxEvents === null ? -1 : this.config.maxEvents ?? this.limit) : this.limit;
  }
  private get ageLimit() { return this.config.backend === 'valkey' ? this.config.ttlSeconds ?? 0 : 0; }

  get connected() { return !this.client || this.client.status === 'ready'; }
  private get settingKey() { return this.prefix + 'limit'; }
  private get indexKey() { return this.prefix + 'cameras'; }
  private eventKey(camera: string) { return this.prefix + 'camera:' + camera; }

  async start(importLimit = false) {
    if (this.client) {
      await this.client.connect().catch(() => {});
      if (importLimit && this.connected) {
        const stored = await this.client.get(this.settingKey).catch(() => { recordError({key:'EVENT_HISTORY_RETENTION_FAILED',caller:'history::restore'}); return null; });
        const count = stored === null ? NaN : Number(stored);
        if (Number.isInteger(count) && count >= 0 && count <= maxEventRetention) this.limit = count;
      }
    }
    this.initializing = false;
    await this.resize().catch(() => recordError({key:'EVENT_HISTORY_RETENTION_FAILED',caller:'history::resize'}));
  }

  private async resize() {
    if (!this.client || !this.connected) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      const cameras = await this.client.smembers(this.indexKey);
      if (await this.client.eval(resize, cameras.length + 2, this.settingKey, this.indexKey, ...cameras, this.countLimit, this.ageLimit, Date.now(), this.limit) === 1) return;
    }
    throw unavailable();
  }

  async setLimit(limit: number) {
    this.limit = limit;
    if (limit === 0) this.memory.clear();
    else for (const events of this.memory.values()) events.splice(0, Math.max(0, events.length - limit));
    await this.resize().catch(() => recordError({key:'EVENT_HISTORY_RETENTION_FAILED',caller:'history::resize'}));
  }

  add({ camera, entry }: { camera: string; entry: CameraEvent }) {
    if (this.client) {
      if (!this.connected || this.countLimit === 0) return;
      if (this.pending >= 256) { recordError({key:'EVENT_HISTORY_BACKLOG',caller:'history::add',context:{camera}}); return; }
      this.pending++;
      void this.client.eval(addEvent, 2, this.indexKey, this.eventKey(camera),
        this.countLimit, this.ageLimit, Date.now(), JSON.stringify(entry), entry.observedAt).catch(() => recordError({key:'EVENT_HISTORY_WRITE_FAILED',caller:'history::add',context:{camera}})).finally(() => { this.pending--; });
      return;
    }
    if (!this.limit) return;
    const events = this.memory.get(camera) ?? [];
    events.push(entry);
    if (events.length > this.limit) events.shift();
    this.memory.set(camera, events);
  }

  async read(camera: string, aliases: string[] = []) {
    const previous = [...new Set(aliases)].filter(key => key !== camera);
    if (!this.client) {
      let events = this.memory.get(camera) ?? [];
      const merged = previous.flatMap(key => this.memory.get(key) ?? []);
      if (merged.length) {
        const unique = new Map([...events,...merged].map(event => [event.id,event]));
        events = this.limit ? [...unique.values()].sort((a,b) => a.observedAt - b.observedAt).slice(-this.limit) : [];
        this.memory.set(camera,events);
        for (const key of previous) this.memory.delete(key);
      }
      return { limit: this.limit, events: [...events] };
    }
    if (this.countLimit === 0 && !previous.length) return { limit: 0, events: [] };
    try {
      const keys = [this.eventKey(camera)];
      if (previous.length) keys.push(this.indexKey, ...previous.map(key => this.eventKey(key)));
      const [limit, events] = await this.client.eval(
        readEvents, keys.length, ...keys, this.countLimit, this.ageLimit, Date.now(), maxEventRetention
      ) as [number, string[]];
      return { limit: limit < 0 ? null : limit, events: events.map(serialized => JSON.parse(serialized) as CameraEvent) };
    } catch { throw unavailable(); }
  }

  close() { this.client?.disconnect(); this.memory.clear(); }
}

const publicValkey = (config: Valkey) => {
  const url = new URL(config.url);
  const passwordConfigured = Boolean(url.password);
  url.password = '';
  return {
    url: url.href, keyPrefix: config.keyPrefix, ca: config.ca, rejectUnauthorized: config.rejectUnauthorized,
    maxEvents: config.maxEvents, ttlSeconds: config.ttlSeconds, passwordConfigured
  };
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
      backend: 'valkey', url: selected.url, keyPrefix: selected.keyPrefix, ca: selected.ca, rejectUnauthorized: selected.rejectUnauthorized,
      maxEvents: selected.maxEvents, ttlSeconds: selected.ttlSeconds, retention
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

  private valkeyUrl({ url: endpoint, password }: { url: URL; password?: string }, saved: HistoryStorage) {
    const url = new URL(endpoint);
    const previous = saved.valkey ?? (this.defaults.backend === 'valkey' ? this.defaults : undefined);
    if (password !== undefined) url.password = encodeURIComponent(password);
    else if (!url.password && previous && publicValkey(previous).url === url.href) url.password = previous.url.password;
    return url;
  }

  async testConnection(draft: HistoryConnectionInput, correlationId: string) {
    if (draft.mode === 'defaults') {
      if (this.defaults.backend !== 'valkey') throw new Failure('BAD_INPUT', 400);
      return testValkey(this.defaults, correlationId);
    }
    const [row] = await this.sql.query<{ storage: string }>('SELECT storage FROM event_history_settings WHERE id=1');
    const saved = historyStorageSchema.parse(JSON.parse(row.storage));
    return testValkey({ ...draft.valkey, url: this.valkeyUrl(draft.valkey, saved) }, correlationId);
  }

  setOptions({ limit, storage }: { limit: number; storage?: HistoryStorageInput }) {
    return this.serialize(async () => {
      const selected = await this.sql.transaction(async query => {
        const [row] = await query<{storage:string}>('SELECT storage FROM event_history_settings WHERE id=1');
        const saved = historyStorageSchema.parse(JSON.parse(row.storage));
        let selected: HistoryStorage = saved;
        if (storage?.mode === 'valkey') {
          const { password, ...fields } = storage.valkey;
          selected = { mode: 'valkey', valkey: { ...fields, url: this.valkeyUrl({ ...fields, password }, saved) } };
        } else if (storage) selected = {...storage,...(saved.valkey ? {valkey:saved.valkey} : {})};
        await query('UPDATE event_history_settings SET retention=$1,storage=$2 WHERE id=1',limit,JSON.stringify(selected));
        return selected;
      });
      await this.apply(selected,limit);
    });
  }

  setLimit({ limit }: { limit: number }) { return this.setOptions({ limit }); }
  add(entry: { camera: string; entry: CameraEvent }) { this.cache.add(entry); }
  async read({ camera, aliases = [] }: { camera: string; aliases?: string[] }) {
    const cache = await this.serialize(async () => { await this.refresh(); return this.cache; });
    return cache.read(camera,aliases);
  }
  async close() { await this.changes; this.cache.close(); }
}
