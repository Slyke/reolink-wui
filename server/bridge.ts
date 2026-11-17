import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Agent } from 'undici';
import type { ActionResult } from './operations.js';
import type { BridgeConfig } from './config.js';
import type { ConnectionState, Upstream, UpstreamConnection } from '../shared/upstreams.js';
import { at, dispatcher, jsonResponse } from './net.js';
import { BrokerChannel, SocketChannel, record, type Envelope } from './bridge-channels.js';
import { Failure } from './errors.js';
import { correlationPattern, segment } from '../shared/urls.js';

import { eventData, type CameraEvent } from './cameras.js';

export type BridgeUpdate = { kind: 'feed' }
  | { kind: 'snapshot'; camera: string; topic: string }
  | { kind: 'event'; camera: string; topic: string; entry: CameraEvent };

type Link = { url: URL; token: string; adminToken?: string; agent: Agent };

const request = ({ link, path, search, token, method, data, correlation, ifNoneMatch, signal }: {
  link: Link; path: string; search?: string; token?: string; method?: string; data?: unknown; correlation?: string;
  ifNoneMatch?: string; signal: AbortSignal
}) => {
  const options: RequestInit & { dispatcher: Agent } = {
    dispatcher: link.agent, method, redirect: 'error', signal,
    headers: {
      authorization: 'Bearer ' + (token ?? link.token),
      ...(data !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(correlation ? { 'x-correlation-id': correlation } : {}),
      ...(ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {})
    },
    body: data === undefined ? undefined : JSON.stringify(data)
  };
  return fetch(at({ base: link.url, path, search }), options);
};

export class Bridge {
  private readonly channel = new EventEmitter().setMaxListeners(0);
  private readonly cache = new Map<string, Map<string, Envelope>>();
  private reportedIds?: Set<string>;
  private readonly allowed = new Set<string>();
  private readonly socket?: SocketChannel;
  private readonly broker?: BrokerChannel;
  private readonly http?: Link;
  private readonly extensions?: Link;
  private readonly bridgeVersion = { v1: false, inventory: false, media: false, enrollment: false };
  private scanning?: Promise<boolean>;
  private readonly mediaStreams = new Map<string, string[]>();
  private previewCameras = new Set<string>();
  private httpState?: boolean;
  private extensionState?: boolean;
  feedReady = false;

  constructor(readonly config: BridgeConfig) {
    const mqttIds = config.mqtt?.cameraIds ?? config.cameraIds;
    const scope = config.events === 'mqtt' && !config.cameraIds.length ? mqttIds : config.cameraIds;
    scope.forEach(id => this.allowed.add(id));
    const changes = {
      refresh: () => {
        this.cache.clear();
        this.feedReady = false;
        this.channel.emit('update', { kind: 'feed' });
      },
      connected: (ready: boolean) => {
        this.feedReady = ready;
        this.channel.emit('update', { kind: 'feed' });
      },
      snapshot: (message: Envelope) => {
        const { camera_id: camera, topic } = message;
        if (typeof camera !== 'string' || !this.inScope(camera) || typeof topic !== 'string'
          || !/^(availability|info|capabilities|rules|state\/[a-zA-Z0-9_:-]{1,96})$/.test(topic)) return;
        let topics = this.cache.get(camera);
        if (!topics) {
          if (this.cache.size >= 128) return;
          topics = new Map();
          this.cache.set(camera, topics);
        }
        if (!topics.has(topic) && topics.size >= 256) return;
        const payload = record(message.payload);
        topics.set(topic, payload);
        this.channel.emit('update', { kind: 'snapshot', camera, topic });
      },
      event: (payload: Envelope) => {
        const { camera_id: camera, type: topic } = payload;
        if (!this.feedReady || typeof camera !== 'string' || !this.inScope(camera) || typeof topic !== 'string') return;
        this.channel.emit('update', {
          kind: 'event', camera, topic, entry: { id: randomUUID(), observedAt: Date.now(), event: eventData({ raw: payload }) }
        });
      }
    };
    if (config.ws && (config.commands === 'ws' || config.events === 'ws' || config.callbacks)) {
      this.socket = new SocketChannel(config.ws, config.cameraIds, config.events === 'ws' ? changes : undefined);
    }
    if (config.mqtt) {
      this.broker = new BrokerChannel(config.mqtt, mqttIds, config.commands === 'mqtt' || !!config.capture, config.events === 'mqtt' ? changes : undefined);
    }
    if (config.http) this.http = { ...config.http, agent: dispatcher({ ca: config.http.ca }) };
    if (config.extensions) this.extensions = { ...config.extensions, agent: dispatcher({ ca: config.extensions.ca }) };
  }

  private inScope(camera: string) {
    return segment.test(camera) && (this.allowed.size === 0 || this.allowed.has(camera));
  }

  includes(camera: string) {
    return this.inScope(camera) && (!this.reportedIds || this.reportedIds.has(camera));
  }

  ids() {
    return this.reportedIds ? [...this.reportedIds] : (this.allowed.size ? [...this.allowed] : [...this.cache.keys()]);
  }

  observe(listener: (update: BridgeUpdate) => void) {
    this.channel.on('update', listener);
    return () => this.channel.off('update', listener);
  }

  state(camera: string) {
    return this.cache.get(camera) ?? new Map<string, Envelope>();
  }

  async command({ camera, id, command, correlation, capture = false }: {
    camera: string; id: string; command: Envelope; correlation: string; capture?: boolean
  }) {
    if (!this.includes(camera)) throw new Failure('CAMERA_UNKNOWN', 404);
    const route = capture ? this.config.capture : this.config.commands;
    if (route === 'mqtt' && this.broker) return this.broker.request({ camera, id, command, snapshot: capture });
    if (route === 'ws' && this.socket) return this.socket.request({ message: { id, op: 'control', camera_id: camera, command } });
    if (route !== 'http' || !this.http) throw new Failure('UNSUPPORTED', 422);
    try {
      const response = await request({
        link: this.http, path: '/api/cameras/' + camera + '/command/exec', method: 'POST', data: { id, command },
        correlation, signal: AbortSignal.timeout(23_000)
      });
      const reply = record(await jsonResponse({ response }));
      if (reply.id !== id || typeof reply.ok !== 'boolean') {
        if ([401, 403, 404].includes(response.status)) throw new Failure('BRIDGE_UNAVAILABLE', 502);
        throw new Failure('OUTCOME_UNKNOWN', 502, 'unknown');
      }
      return reply;
    } catch (error) {
      if (error instanceof Failure && error.key === 'BRIDGE_UNAVAILABLE') throw error;
      throw new Failure('OUTCOME_UNKNOWN', 504, 'unknown');
    }
  }

  callbacks(message: Envelope & { id: string }) {
    if (!this.config.callbacks || !this.socket) throw new Failure('UNSUPPORTED', 422);
    return this.socket.request({ message });
  }

  has(feature: 'v1' | 'media' | 'enrollment') {
    return this.bridgeVersion[feature];
  }

  canCapture(camera: string) {
    return this.config.capture === 'mqtt'
      && (this.config.mqtt?.cameraIds ?? this.config.cameraIds).includes(camera)
      && Boolean(this.state(camera).get('capabilities')?.baichuan);
  }

  streams(camera: string) {
    return this.has('media') ? this.mediaStreams.get(camera) ?? [] : [];
  }

  hasPreview(camera: string) {
    return this.has('v1') && this.previewCameras.has(camera);
  }

  async app({ path, search, admin = false, data, correlation, ifNoneMatch, signal, method }: {
    path: string; search?: string; admin?: boolean; data?: unknown; correlation?: string;
    ifNoneMatch?: string; signal?: AbortSignal; method?: string
  }) {
    const link = this.extensions;
    if (!link || (admin && !link.adminToken)) throw new Failure('UNSUPPORTED', 422);
    try {
      return await request({
        link, path: '/api/wui/v1' + path, search, token: admin ? link.adminToken : undefined, method,
        data, correlation, ifNoneMatch, signal: signal ?? AbortSignal.timeout(admin ? 65_000 : 18_000)
      });
    } catch {
      throw new Failure(data === undefined ? 'BRIDGE_UNAVAILABLE' : 'OUTCOME_UNKNOWN', 502, data === undefined ? undefined : 'unknown');
    }
  }

  upstream(): Upstream {
    const connections: UpstreamConnection[] = [];
    const state = ({ connected }: { connected?: boolean }): ConnectionState => {
      if (connected === undefined) return 'checking';
      return connected ? 'online' : 'offline';
    };
    const { config } = this;

    if (config.commands === 'http' && config.http) {
      connections.push({
        id: 'http', transport: config.http.url.protocol === 'https:' ? 'HTTPS' : 'HTTP',
        uses: ['commands'], state: state({ connected: this.httpState })
      });
    }
    if (this.socket && config.ws) {
      const uses: UpstreamConnection['uses'] = [];
      if (config.commands === 'ws') uses.push('commands');
      if (config.events === 'ws') uses.push('events');
      if (config.callbacks) uses.push('callbacks');
      connections.push({
        id: 'ws', transport: config.ws.url.protocol === 'wss:' ? 'WSS' : 'WS', uses,
        state: state({ connected: this.socket.ready && (config.events !== 'ws' || this.feedReady) })
      });
    }
    if (this.broker && config.mqtt) {
      const uses: UpstreamConnection['uses'] = [];
      if (config.commands === 'mqtt') uses.push('commands');
      if (config.events === 'mqtt') uses.push('events');
      if (config.capture) uses.push('capture');
      if (uses.length === 0) uses.push('connectivity');
      connections.push({
        id: 'mqtt', transport: config.mqtt.url.protocol === 'mqtts:' ? 'MQTT TLS' : 'MQTT', uses,
        state: state({ connected: this.broker.ready && (config.events !== 'mqtt' || this.feedReady) })
      });
    }
    if (config.extensions) {
      connections.push({
        id: 'extensions', transport: config.extensions.url.protocol === 'https:' ? 'HTTPS' : 'HTTP',
        uses: ['extensions'], state: state({ connected: this.extensionState })
      });
    }
    return { id: config.id, label: config.label, connections };
  }

  scanInventory() {
    if (!this.bridgeVersion.inventory) return Promise.resolve(false);
    this.scanning ??= this.app({ path: '/inventory', signal: AbortSignal.timeout(2000) }).then(async response => {
      const inventory = record(await jsonResponse({ response })).cameras;
      if (!response.ok || !Array.isArray(inventory)) throw new Failure('BRIDGE_UNAVAILABLE', 502);
      const ids = new Set(inventory.map(item => record(item).id).filter((id): id is string => (
        typeof id === 'string' && this.inScope(id)
      )).slice(0, 128));
      const previous = this.reportedIds;
      this.reportedIds = ids;
      if (!previous || ids.size !== previous.size || [...ids].some(id => !previous.has(id))) {
        this.channel.emit('update', { kind: 'feed' });
      }
      return true;
    }).finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  async refreshInventory() {
    if (this.extensions) {
      await this.check();
      if (await this.scanInventory()) return;
    }
    if (!this.feedReady) throw new Failure('BRIDGE_UNAVAILABLE', 502);
    if (this.config.events === 'ws') await this.socket?.refreshSnapshots();
  }

  async check() {
    const options = [];
    const signal = AbortSignal.timeout(2000);
    if (this.config.commands === 'http' && this.http) {
      options.push(request({ link: this.http, path: '/livez', signal }).then(async response => {
        await response.body?.cancel();
        return response.ok;
      }).catch(() => false).then(healthy => {
        this.httpState = healthy;
        return healthy;
      }));
    }
    if (this.extensions) {
      options.push(this.app({ path: '/contract', signal }).then(async response => {
        const contract = record(await jsonResponse({ response }));
        const before = JSON.stringify([this.bridgeVersion, [...this.mediaStreams], [...this.previewCameras]]);
        const ok = response.ok && contract.version === 1;
        this.bridgeVersion.v1 = ok;
        this.bridgeVersion.inventory = ok && contract.inventory === true;
        this.bridgeVersion.media = ok && !!this.config.extensions?.relay && contract.media === true;
        this.mediaStreams.clear();
        for (const [camera, streams] of Object.entries(record(contract.mediaCameras))) {
          if (this.inScope(camera) && Array.isArray(streams)) {
            this.mediaStreams.set(camera, streams.filter(value => value === 'main' || value === 'sub'));
          }
        }
        this.previewCameras = new Set(ok && Array.isArray(contract.previewCameras) ? contract.previewCameras
          .slice(0, 128).filter((camera): camera is string => typeof camera === 'string' && this.inScope(camera)) : []);
        this.bridgeVersion.enrollment = ok && !!this.extensions?.adminToken && contract.enrollment === true;
        if (before !== JSON.stringify([this.bridgeVersion, [...this.mediaStreams], [...this.previewCameras]])) this.channel.emit('update', { kind: 'feed' });
        return ok;
      }).catch(() => {
        this.bridgeVersion.v1 = this.bridgeVersion.inventory = this.bridgeVersion.media = this.bridgeVersion.enrollment = false;
        return false;
      }).then(healthy => {
        this.extensionState = healthy;
        return healthy;
      }));
    }
    const healthy = (await Promise.all(options)).every(Boolean);
    const mqttRequired = this.config.commands === 'mqtt' || this.config.events === 'mqtt' || this.config.capture === 'mqtt';
    return healthy && this.feedReady && (!mqttRequired || this.broker?.ready === true) && (!this.socket || this.socket.ready);
  }

  async close() {
    this.socket?.close();
    await Promise.all([this.broker?.close(), this.http?.agent.destroy(), this.extensions?.agent.destroy()]);
  }
}

const rejectedBeforeWrite = new Set([
  'CONTROL_ID_CONFLICT', 'CONTROL_VALIDATION_FAILED', 'CONTROL_TRANSPORT_DISABLED', 'CONTROL_QUEUE_UNAVAILABLE',
  'CONTROL_CAPABILITIES_UNAVAILABLE', 'CONTROL_UNSUPPORTED', 'CONTROL_SETTING_UNSUPPORTED',
  'PTZ_CAPABILITIES_UNAVAILABLE', 'PTZ_UNSUPPORTED', 'PTZ_TRANSPORT_DISABLED', 'PTZ_SPEED_UNSUPPORTED',
  'PTZ_ZOOM_OUT_OF_RANGE', 'PTZ_PRESET_UNKNOWN', 'PTZ_REQUEST_EXPIRED', 'PTZ_QUEUED_MOVE_CANCELLED',
  'SNAPSHOT_CAPTURE_BUSY', 'CALLBACK_CONFIG_INVALID', 'CALLBACK_UPDATE_MISSING', 'CALLBACK_REMOVE_MISSING',
  'CALLBACK_CONFIG_CHANGED', 'CALLBACK_DESTINATION_DENIED', 'WUI_SCOPE_DENIED'
]);

export const result = ({ reply, write }: { reply: Envelope; write: boolean }): ActionResult => {
  const bridgeCorrelationId = typeof reply.correlation_id === 'string' && correlationPattern.test(reply.correlation_id)
    ? reply.correlation_id : undefined;
  if (reply.ok !== true) {
    const known = !write || (typeof reply.errorKey === 'string' && rejectedBeforeWrite.has(reply.errorKey));
    return {
      outcome: known ? 'rejected' : 'unknown', bridgeCorrelationId,
      reason: known ? 'COMMAND_REJECTED' : 'OUTCOME_UNKNOWN'
    };
  }
  return { outcome: reply.verified === false ? 'unverified' : 'confirmed', bridgeCorrelationId, reason: undefined };
};
