import { Redis } from 'ioredis';
import type { CameraEvent } from './cameras.js';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import { Failure } from './errors.js';

const addEvent = `
local keep = tonumber(redis.call('GET', KEYS[1]) or ARGV[1])
if keep > 0 then
  redis.call('SADD', KEYS[2], KEYS[3])
  redis.call('LPUSH', KEYS[3], ARGV[2])
  redis.call('LTRIM', KEYS[3], 0, keep - 1)
end
`;

const readEvents = `
local keep = tonumber(redis.call('GET', KEYS[1]) or ARGV[1])
if keep == 0 then return {keep, {}} end
return {keep, redis.call('LRANGE', KEYS[2], 0, keep - 1)}
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

export class EventHistory {
  private readonly memory = new Map<string, CameraEvent[]>();
  private readonly client?: Redis;
  private readonly prefix: string;
  private limit: number;
  private pending = 0;

  constructor(private readonly config: Config['eventHistory'], private readonly sql: Sql) {
    this.limit = config.retention;
    this.prefix = config.backend === 'valkey' ? config.keyPrefix + ':events:' : '';
    if (config.backend === 'valkey') {
      this.client = new Redis(config.url.href, {
        ...(config.url.protocol === 'rediss:' ? {
          tls: { ca: config.ca, rejectUnauthorized: true }
        } : {}),
        connectTimeout: 2_000, commandTimeout: 2_000, enableReadyCheck: false, enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false, maxRetriesPerRequest: 0
      });
      this.client.on('error', () => {}); // Failed history requests report a safe error to the WUI.
    }
  }

  private get settingKey() { return this.prefix + 'limit'; }
  private get indexKey() { return this.prefix + 'cameras'; }
  private eventKey({ camera }: { camera: string }) { return this.prefix + 'camera:' + camera; }

  async start() {
    if (!this.client) {
      const [stored] = await this.sql.query<{ retention: number }>('SELECT retention FROM event_history_settings WHERE id=1');
      this.limit = stored?.retention ?? this.config.retention;
    }
  }

  settings() {
    if (!this.client) return Promise.resolve({ backend: this.config.backend, limit: this.limit });
    return this.client.get(this.settingKey).then(limit => ({
      backend: this.config.backend, limit: limit === null ? this.config.retention : Number(limit)
    })).catch(() => { throw unavailable(); });
  }

  async setLimit({ limit }: { limit: number }) {
    if (this.client) {
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          const cameras = await this.client.smembers(this.indexKey);
          // The script retries if the camera index changed while it was being read.
          if (await this.client.eval(resize, cameras.length + 2, this.settingKey, this.indexKey, ...cameras, limit) === 1) return;
        }
      } catch {
        throw unavailable();
      }
      throw unavailable();
    }
    await this.sql.query(
      'INSERT INTO event_history_settings(id,retention) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET retention=excluded.retention', limit
    );
    this.limit = limit;
    if (limit === 0) this.memory.clear();
    else for (const events of this.memory.values()) events.splice(0, Math.max(0, events.length - limit));
  }

  add({ camera, entry }: { camera: string; entry: CameraEvent }) {
    if (this.client) {
      if (this.client.status !== 'ready' || this.pending >= 256) return;
      this.pending++;
      void this.client.eval(addEvent, 3, this.settingKey, this.indexKey, this.eventKey({ camera }),
        this.config.retention, JSON.stringify(entry)).catch(() => {}).finally(() => { this.pending--; });
      return;
    }
    if (!this.limit) return;
    const events = this.memory.get(camera) ?? [];
    events.push(entry);
    if (events.length > this.limit) events.shift();
    this.memory.set(camera, events);
  }

  async read({ camera }: { camera: string }) {
    if (!this.client) return { limit: this.limit, events: [...(this.memory.get(camera) ?? [])] };
    try {
      const [limit, events] = await this.client.eval(
        readEvents, 2, this.settingKey, this.eventKey({ camera }), this.config.retention
      ) as [number, string[]];
      return { limit, events: events.reverse().map(serialized => JSON.parse(serialized) as CameraEvent) };
    } catch {
      throw unavailable();
    }
  }

  close() {
    this.client?.disconnect();
    this.memory.clear();
  }
}
