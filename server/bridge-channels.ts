import WebSocket from 'ws';
import mqtt, { type MqttClient } from 'mqtt';
import { randomUUID } from 'node:crypto';
import type { ConnectionOptions } from 'node:tls';
import { Failure } from './errors.js';
import { trust } from './net.js';
import type { BridgeConfig } from './config.js';
import type { FeedConnectionFailure } from '../shared/events.js';

export type Envelope = Record<string, unknown>;
export const record = (value: unknown): Envelope => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Envelope : {}
);
const parse = (payload: Buffer | string): Envelope => {
  try { return record(JSON.parse(payload.toString())); } catch { return {}; }
};

type Waiting = { reject: (error: Error) => void; complete: (value: Envelope) => void };
class Replies {
  private readonly entries = new Map<string, Waiting>();

  wait({ key, send, ms }: { key: string; send: () => void; ms: number }) {
    if (this.entries.has(key) || this.entries.size >= 64) throw new Failure('COMMAND_BUSY', 409);
    return new Promise<Envelope>((resolve, reject) => {
      const settle = () => { clearTimeout(timer); this.entries.delete(key); };
      const timer = setTimeout(() => this.entries.get(key)?.reject(new Failure('OUTCOME_UNKNOWN', 504, 'unknown')), ms);
      this.entries.set(key, {
        complete: value => { settle(); return resolve(value); },
        reject: error => { settle(); return reject(error); }
      });
      try { send(); } catch { this.entries.get(key)?.reject(new Failure('OUTCOME_UNKNOWN', 502, 'unknown')); }
    });
  }

  match({ key, value }: { key: string; value: Envelope }) {
    if (typeof value.ok === 'boolean') this.entries.get(key)?.complete(value);
  }

  lost() {
    for (const waiting of this.entries.values()) waiting.reject(new Failure('OUTCOME_UNKNOWN', 502, 'unknown'));
  }
}

const connectionFailure = (error: Error): FeedConnectionFailure => {
  const { code } = error as Error & { code?: number | string };
  if (typeof code === 'string' && /^(?:ERR_TLS_CERT_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_(?:GET_ISSUER_CERT|VERIFY_LEAF_SIGNATURE))/.test(code)) {
    return 'tls';
  }
  if ((typeof code === 'number' && [4, 5, 0x86, 0x87].includes(code))
    || /^Unexpected server response: (401|403)$/.test(error.message)) return 'authorization';
  return 'transport';
};

export type ChannelChanges = {
  refresh: () => void;
  connected: (ready: boolean, failure?: FeedConnectionFailure) => void;
  snapshot: (message: Envelope) => void;
  event: (message: Envelope) => void;
  gap: () => void;
};

export class SocketChannel {
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private ended = false;
  private readonly replies = new Replies();
  ready?: boolean;

  constructor(
    private readonly conf: NonNullable<BridgeConfig['ws']>,
    private readonly ids: string[],
    private readonly changes: ChannelChanges
  ) {
    this.open();
  }

  private open() {
    const socket = new WebSocket(this.conf.url, {
      headers: { authorization: 'Bearer ' + this.conf.token },
      ca: trust({ ca: this.conf.ca }), handshakeTimeout: 3500, maxPayload: 2_000_000, followRedirects: false
    });
    this.socket = socket;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let responsive = true;
    let failure: FeedConnectionFailure | undefined;
    socket.on('error', error => {
      failure ??= connectionFailure(error);
      socket.terminate();
    });
    socket.on('close', () => {
      clearInterval(heartbeat);
      this.ready = false;
      this.replies.lost();
      if (this.ended) return;
      this.changes.connected(false, failure ?? 'transport');
      this.retry = setTimeout(() => this.open(), 1500);
    });
    socket.on('pong', () => { responsive = true; });
    socket.on('open', () => {
      heartbeat = setInterval(() => {
        if (!responsive) {
          failure = 'heartbeat';
          return socket.terminate();
        }
        responsive = false;
        socket.ping();
      }, 8000);
      void this.request({ op: 'subscribe', cameras: this.ids }).then(reply => {
        if (this.ended || socket.readyState !== WebSocket.OPEN) return;
        if (reply.ok !== true || !Array.isArray(reply.snapshots)) {
          failure = 'subscription';
          socket.terminate();
          return;
        }
        this.changes.refresh();
        for (const item of reply.snapshots) this.changes.snapshot(record(item));
        this.ready = true;
        this.changes.connected(true);
      }).catch(() => {
        if (socket.readyState === WebSocket.OPEN) {
          failure ??= 'subscription';
          socket.terminate();
        }
      });
    });
    socket.on('message', (data, binary) => {
      if (binary) return;
      const message = parse(data.toString());
      if (typeof message.id === 'string') return this.replies.match({ key: message.id, value: message });
      if (!this.ready) return;
      if (message.op === 'event') this.changes.event(record(message.event));
      if (message.op === 'snapshot') this.changes.snapshot(record(message.snapshot));
      if (message.op === 'gap') {
        this.changes.gap();
        this.changes.refresh();
        if (Array.isArray(message.snapshots)) for (const item of message.snapshots) this.changes.snapshot(record(item));
        this.changes.connected(true);
      }
    });
  }

  private request(message: Envelope) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Failure('BRIDGE_UNAVAILABLE', 503);
    const id = randomUUID();
    return this.replies.wait({
      key: id, ms: 4500, send: () => socket.send(JSON.stringify({ ...message, id }), error => {
        if (error) socket.terminate();
      })
    });
  }

  async refreshSnapshots() {
    const response = await this.request({ op: 'snapshot' });
    if (response.ok !== true || !Array.isArray(response.snapshots)) throw new Failure('BRIDGE_UNAVAILABLE', 502);
    for (const item of response.snapshots) this.changes.snapshot(record(item));
  }

  close() {
    this.ended = true;
    clearTimeout(this.retry);
    this.socket?.terminate();
  }
}

const maxPacket = 25_200_000;
const eventTopics = ['availability', 'info', 'capabilities', 'rules', 'state/+', 'events'];

export class BrokerChannel {
  private readonly client: MqttClient;
  private readonly replies = new Replies();
  private targets: Set<string>;
  private readonly subscribed = new Set<string>();
  private generation = 0;
  private subscribing?: Promise<void>;
  private failure?: FeedConnectionFailure;
  private closed = false;
  ready = false;

  constructor(
    private readonly config: BridgeConfig['mqtt'], ids: string[],
    private readonly controls: boolean, private readonly changes?: ChannelChanges
  ) {
    this.targets = new Set(ids);
    const tlsOptions = { allowPartialTrustChain: config.allowPartialTrustChain } satisfies Pick<ConnectionOptions, 'allowPartialTrustChain'>;
    this.client = mqtt.connect(config.url.toString(), {
      ...tlsOptions,
      protocolVersion: 5, clientId: 'wui-' + randomUUID(), username: config.username, password: config.password,
      ca: trust({ ca: config.ca }), rejectUnauthorized: true, clean: true, resubscribe: false,
      queueQoSZero: false, reconnectPeriod: 1500, connectTimeout: 3500, keepalive: 10,
      properties: { maximumPacketSize: maxPacket }
    });
    this.client.on('close', () => {
      this.generation++;
      this.subscribing = undefined;
      this.subscribed.clear();
      this.ready = false;
      this.replies.lost();
      if (!this.closed) changes?.connected(false, this.failure ?? 'transport');
      this.failure = undefined;
    });
    // MQTT.js owns socket recovery.
    this.client.on('error', error => { this.failure ??= connectionFailure(error); });
    this.client.on('connect', () => {
      this.failure = undefined;
      changes?.refresh();
      this.syncSubscriptions();
    });
    this.client.on('message', (topic, payload, packet) => {
      if (!payload.length || payload.length > maxPacket || !topic.startsWith(config.baseTopic + '/')) return;
      const path = topic.slice(config.baseTopic.length + 1);
      const firstSlash = path.indexOf('/');
      if (firstSlash < 1) return;
      const id = path.slice(0, firstSlash);
      if (!this.targets.has(id)) return;
      const suffix = path.slice(firstSlash + 1);
      if (suffix === 'command/result') {
        if (packet.retain || !this.ready) return;
        const message = parse(payload);
        if (typeof message.id === 'string') this.replies.match({ key: id + '/' + message.id, value: message });
      } else if (suffix === 'events') {
        if (!packet.retain && this.ready) changes?.event({ ...parse(payload), camera_id: id });
      } else if (/^(availability|info|capabilities|rules|state\/[a-zA-Z0-9_:-]{1,96})$/.test(suffix) && payload.length < 2_000_000) {
        changes?.snapshot({ camera_id: id, topic: suffix, payload: parse(payload) });
      }
    });
  }

  includes(camera: string) {
    return this.targets.has(camera);
  }

  setCameraIds(ids: string[]) {
    const targets = new Set(ids);
    if (targets.size === this.targets.size && [...targets].every(id => this.targets.has(id))) return false;
    this.targets = targets;
    if (targets.size && this.subscribed.size === 0 && this.ready) {
      this.ready = false;
      this.changes?.connected(false);
    }
    this.syncSubscriptions();
    return true;
  }

  private syncSubscriptions() {
    if (this.closed || this.subscribing || !this.client.connected) return;
    const suffixes = this.changes ? [...eventTopics] : [];
    if (this.controls) suffixes.push('command/result');
    const topics = new Set([...this.targets].flatMap(id => suffixes.map(suffix => this.config.baseTopic + '/' + id + '/' + suffix)));
    const add = [...topics].filter(topic => !this.subscribed.has(topic));
    const remove = [...this.subscribed].filter(topic => !topics.has(topic));
    if (!add.length && !remove.length) {
      this.ready = true;
      this.changes?.connected(true);
      return;
    }
    const generation = this.generation;
    const current = () => generation === this.generation && this.client.connected && !this.closed;
    this.subscribing = this.updateSubscriptions({ add, remove, current }).then(updated => {
      if (!updated) return;
      this.subscribing = undefined;
      this.syncSubscriptions();
    }).catch(() => {
      // Prepare a clean session following rejected or interrupted subscriptions.
      if (current()) {
        this.failure = 'subscription';
        this.client.reconnect();
      }
    });
  }

  private async updateSubscriptions({ add, remove, current }: { add: string[]; remove: string[]; current: () => boolean }) {
    if (add.length) {
      const granted = await this.client.subscribeAsync(add, { qos: 1 });
      if (!current()) return false;
      if (granted.length !== add.length || granted.some(entry => entry.qos > 2)) throw new Error('MQTT subscription rejected');
      for (const topic of add) this.subscribed.add(topic);
    }
    if (remove.length) {
      await this.client.unsubscribeAsync(remove);
      if (!current()) return false;
      for (const topic of remove) this.subscribed.delete(topic);
    }
    return current();
  }

  request({ camera, id, command, snapshot = false }: { camera: string; id: string; command: Envelope; snapshot?: boolean }) {
    if (!this.controls || !this.includes(camera)) throw new Failure('UNSUPPORTED', 422);
    const path = this.config.baseTopic + '/' + camera;
    if (!this.ready || !this.client.connected || !this.subscribed.has(path + '/command/result')) throw new Failure('BRIDGE_UNAVAILABLE', 503);
    return this.replies.wait({
      key: camera + '/' + id, ms: snapshot ? 37_000 : 24_000,
      // QoS 0 with offline queueing off means the client cannot retransmit queued writes on reconnect.
      send: () => this.client.publish(path + '/command/exec', JSON.stringify({ id, command }), { qos: 0, retain: false }, error => {
        if (error) this.replies.lost();
      })
    });
  }

  close() {
    this.closed = true;
    this.replies.lost();
    return this.client.endAsync(true);
  }
}
