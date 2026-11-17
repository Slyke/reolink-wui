import WebSocket from 'ws';
import mqtt, { type MqttClient } from 'mqtt';
import { randomUUID } from 'node:crypto';
import type { ConnectionOptions } from 'node:tls';
import { Failure } from './errors.js';
import { trust } from './net.js';
import type { BridgeConfig } from './config.js';

export type Envelope = Record<string, unknown>;
export const record = (value: unknown): Envelope => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Envelope : {}
);
const parse = (payload: Buffer | string): Envelope => {
  try { return record(JSON.parse(payload.toString())); } catch { return {}; }
};

type Waiting = { reject: (error: Error) => void; complete: (value: Envelope) => void };
export class Replies {
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

type Channels = {
  refresh: () => void;
  connected: (ready: boolean) => void;
  snapshot: (message: Envelope) => void;
  event: (message: Envelope) => void;
};

export class SocketChannel {
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private ended = false;
  private readonly replies = new Replies();
  ready = false;

  constructor(private readonly conf: NonNullable<BridgeConfig['ws']>, private readonly ids: string[], private readonly changes?: Channels) {
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
    this.changes?.connected(false);
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearInterval(heartbeat);
      this.ready = false;
      this.replies.lost();
      this.changes?.connected(false);
      if (!this.ended) this.retry = setTimeout(() => this.open(), 1500);
    });
    socket.on('pong', () => { responsive = true; });
    socket.on('open', () => {
      this.ready = true;
      heartbeat = setInterval(() => {
        if (!responsive) return socket.terminate();
        responsive = false;
        socket.ping();
      }, 8000);
      if (!this.changes) return;
      void this.request({ message: { id: randomUUID(), op: 'subscribe', cameras: this.ids } }).then(reply => {
        if (reply.ok !== true || !Array.isArray(reply.snapshots)) return socket.terminate();
        this.changes?.refresh();
        for (const item of reply.snapshots) this.changes?.snapshot(record(item));
        this.changes?.connected(true);
      }).catch(() => socket.terminate());
    });
    socket.on('message', (data, binary) => {
      if (binary) return;
      const message = parse(data.toString());
      if (typeof message.id === 'string') return this.replies.match({ key: message.id, value: message });
      if (message.op === 'event') this.changes?.event(record(message.event));
      if (message.op === 'snapshot') this.changes?.snapshot(record(message.snapshot));
      if (message.op === 'gap') {
        this.changes?.refresh();
        if (Array.isArray(message.snapshots)) for (const item of message.snapshots) this.changes?.snapshot(record(item));
        this.changes?.connected(true);
      }
    });
  }

  async refreshSnapshots() {
    const reply = await this.request({ message: { id: randomUUID(), op: 'snapshot' } });
    if (reply.ok !== true || !Array.isArray(reply.snapshots)) throw new Failure('BRIDGE_UNAVAILABLE', 502);
    for (const item of reply.snapshots) this.changes?.snapshot(record(item));
  }

  request({ message }: { message: Envelope & { id: string } }) {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== WebSocket.OPEN) throw new Failure('BRIDGE_UNAVAILABLE', 503);
    return this.replies.wait({
      key: message.id, ms: 24_000, send: () => socket.send(JSON.stringify(message), error => {
        if (error) socket.terminate();
      })
    });
  }

  close() {
    this.ended = true;
    clearTimeout(this.retry);
    this.socket?.terminate();
  }
}

const maxPacket = 25_200_000;
export class BrokerChannel {
  private readonly client: MqttClient;
  private readonly replies = new Replies();
  private readonly targets = new Map<string, string>();
  private generation = 0;
  ready = false;

  constructor(
    config: NonNullable<BridgeConfig['mqtt']>, ids: string[],
    controls: boolean, private readonly changes?: Channels
  ) {
    const topics: string[] = [];
    for (const id of ids) {
      const path = config.baseTopic + '/' + id;
      this.targets.set(path, id);
      if (controls) topics.push(path + '/command/result');
      if (changes) for (const suffix of ['availability', 'info', 'capabilities', 'rules', 'state/+', 'events']) topics.push(path + '/' + suffix);
    }
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
      this.ready = false;
      this.replies.lost();
      changes?.connected(false);
    });
    this.client.on('error', () => {}); // The MQTT client owns socket recovery.
    this.client.on('connect', () => {
      if (!topics.length) {
        this.ready = true;
        return;
      }
      const generation = ++this.generation;
      changes?.refresh();
      void this.client.subscribeAsync(topics, { qos: 1 }).then(granted => {
        if (generation !== this.generation || !this.client.connected) return;
        if (granted.length !== topics.length || granted.some(entry => entry.qos > 2)) {
          this.client.reconnect();
          return;
        }
        this.ready = true;
        changes?.connected(true);
      }).catch(() => {
        if (generation === this.generation && this.client.connected) this.client.reconnect();
      });
    });
    this.client.on('message', (topic, payload, packet) => {
      if (!payload.length || payload.length > maxPacket) return;
      const path = topic.slice(config.baseTopic.length + 1);
      const base = topic.slice(0, config.baseTopic.length + 1 + path.indexOf('/'));
      const id = this.targets.get(base);
      if (!id) return;
      const suffix = topic.slice(base.length + 1);
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
    this.commandPath = config.baseTopic;
  }

  private readonly commandPath: string;

  request({ camera, id, command, snapshot = false }: { camera: string; id: string; command: Envelope; snapshot?: boolean }) {
    const path = this.commandPath + '/' + camera;
    if (!this.targets.has(path)) throw new Failure('UNSUPPORTED', 422);
    if (!this.ready || !this.client.connected) throw new Failure('BRIDGE_UNAVAILABLE', 503);
    return this.replies.wait({
      key: camera + '/' + id, ms: snapshot ? 37_000 : 24_000,
      // QoS 0 with offline queueing off means the client cannot retransmit queued writes on reconnect.
      send: () => this.client.publish(path + '/command/exec', JSON.stringify({ id, command }), { qos: 0, retain: false }, error => {
        if (error) this.replies.lost();
      })
    });
  }

  close() {
    this.replies.lost();
    return this.client.endAsync(true);
  }
}
