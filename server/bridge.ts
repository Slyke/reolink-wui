import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Agent } from 'undici';
import type { ActionResult } from './operations.js';
import type { BridgeConfig } from './config.js';
import type { ConnectionState, Upstream, UpstreamConnection } from '../shared/upstreams.js';
import { at, dispatcher, jsonResponse } from './net.js';
import { BrokerChannel, SocketChannel, record, type ChannelChanges, type Envelope } from './bridge-channels.js';
import { Failure } from './errors.js';
import { correlationPattern, segment } from '../shared/urls.js';

import { eventData, type CameraEvent } from './cameras.js';
import type { FeedConnectionFailure, FeedGap } from '../shared/events.js';

type BridgeInterruption = Extract<FeedGap, { cause: 'bridge-connection' }>;
type EventSource = BridgeConfig['events']['primary'];
type FeedState = {
  transport: BridgeInterruption['transport'];
  cache: Map<string, Map<string, Envelope>>;
  ready?: boolean;
};

export type BridgeUpdate = { kind: 'feed' }
  | { kind: 'gap'; details: Extract<FeedGap, { cause: 'bridge-connection' | 'bridge-backlog' }> }
  | { kind: 'snapshot'; camera: string; topic: string }
  | { kind: 'event'; camera: string; topic: string; entry: CameraEvent };

type Link = { url: URL; token: string; adminToken?: string; agent: Agent };

const request = ({ link, path, search, token, method, data, correlation, ifNoneMatch, range, signal }: {
  link: Link; path: string; search?: string; token?: string; method?: string; data?: unknown; correlation?: string;
  ifNoneMatch?: string; range?: string; signal: AbortSignal
}) => {
  const options: RequestInit & { dispatcher: Agent } = {
    dispatcher: link.agent, method, redirect: 'error', signal,
    headers: {
      authorization: 'Bearer ' + (token ?? link.token),
      ...(data !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(correlation ? { 'x-correlation-id': correlation } : {}),
      ...(ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}),
      ...(range ? { range } : {})
    },
    body: data === undefined ? undefined : JSON.stringify(data)
  };
  return fetch(at({ base: link.url, path, search }), options);
};

export class Bridge {
  private readonly channel = new EventEmitter().setMaxListeners(0);
  private readonly feeds = new Map<EventSource, FeedState>();
  private lastFeed?: EventSource;
  private readonly recent = new Map<string, { source: EventSource; expires: number }>();
  private reportedIds?: Set<string>;
  private readonly allowed = new Set<string>();
  private readonly broker: BrokerChannel;
  private readonly socket?: SocketChannel;
  private readonly http?: Link;
  private readonly bridgeVersion = { v1: false, inventory: false, media: false, enrollment: false, callbacks: false };
  private scanning?: Promise<boolean>;
  private readonly mediaStreams = new Map<string, string[]>();
  private previewCameras = new Set<string>();
  private recordingCameras = new Set<string>();
  private httpState?: boolean;
  private interruption?: BridgeInterruption;
  private get activeFeed() {
    return [...this.feeds].find(([, feed]) => feed.ready)?.[0];
  }

  get feedReady() { return this.activeFeed !== undefined; }
  get feedGap() { return this.interruption; }

  constructor(readonly config: BridgeConfig) {
    const scope = config.cameraIds.length ? config.cameraIds : config.mqtt.cameraIds ?? [];
    scope.forEach(id => this.allowed.add(id));

    const { primary, secondary } = config.events;
    const ws = config.ws ?? (config.http && {
      url: at({ base: config.http.url, path: '/ws' }),
      token: config.http.token, ca: config.http.ca
    });
    if (ws && !config.ws) ws.url.protocol = ws.url.protocol === 'https:' ? 'wss:' : 'ws:';
    for (const name of [primary, secondary]) {
      if (!name) continue;
      const transport = name === 'ws' ? (ws?.url.protocol === 'wss:' ? 'WSS' : 'WS')
        : (config.mqtt.url.protocol === 'mqtts:' ? 'MQTT TLS' : 'MQTT');
      this.feeds.set(name, { transport, cache: new Map() });
    }
    const mqtt = this.feeds.get('mqtt');
    this.broker = new BrokerChannel(
      config.mqtt, config.mqtt.cameraIds ?? scope, config.commands === 'mqtt' || !!config.capture,
      mqtt && this.channelChanges({ source: 'mqtt', feed: mqtt })
    );
    const socket = this.feeds.get('ws');
    if (socket && ws) this.socket = new SocketChannel(ws, scope, this.channelChanges({ source: 'ws', feed: socket }));
    if (config.http) this.http = { ...config.http, agent: dispatcher({ ca: config.http.ca }) };
  }

  private channelChanges({ source, feed }: { source: EventSource; feed: FeedState }): ChannelChanges {
    const bridgeSource = { bridge: this.config.label, transport: feed.transport };
    const updateBrokerTargets = () => {
      // Legacy bridges can disclose the exact camera IDs in their WebSocket snapshots.
      if (source === 'ws' && !this.reportedIds && !this.allowed.size && !this.bridgeVersion.inventory) {
        this.broker.setCameraIds([...feed.cache.keys()]);
      }
    };
    return {
      refresh: () => feed.cache.clear(),
      connected: (ready, failure) => {
        const previous = this.activeFeed;
        feed.ready = ready;
        if (ready) updateBrokerTargets();
        const active = this.activeFeed;
        if (active) {
          this.lastFeed = active;
          if (this.interruption) {
            this.channel.emit('update', {
              kind: 'gap', details: { ...this.interruption, recoveredAt: Date.now() }
            });
            this.interruption = undefined;
          }
        } else if (failure && (previous || [...this.feeds.values()].every(item => item.ready === false))
          && (this.interruption?.failure !== failure || this.interruption.transport !== feed.transport)) {
          this.interruption = {
            id: this.interruption?.id ?? randomUUID(), detectedAt: this.interruption?.detectedAt ?? Date.now(),
            cause: 'bridge-connection', ...bridgeSource, failure
          };
          this.channel.emit('update', { kind: 'gap', details: this.interruption });
        }
        if (previous !== active || (active === source && ready)) this.channel.emit('update', { kind: 'feed' });
      },
      gap: () => {
        if (this.activeFeed !== source) return;
        this.channel.emit('update', {
          kind: 'gap', details: { id: randomUUID(), detectedAt: Date.now(), cause: 'bridge-backlog', ...bridgeSource }
        });
      },
      snapshot: (message) => {
        const { camera_id: camera, topic } = message;
        if (typeof camera !== 'string' || !this.inScope(camera) || typeof topic !== 'string'
          || !/^(availability|info|capabilities|rules|state\/[a-zA-Z0-9_:-]{1,96})$/.test(topic)) return;
        let topics = feed.cache.get(camera);
        if (!topics) {
          if (feed.cache.size >= 128) return;
          topics = new Map();
          feed.cache.set(camera, topics);
          if (feed.ready) updateBrokerTargets();
        }
        if (!topics.has(topic) && topics.size >= 256) return;
        topics.set(topic, record(message.payload));
        if (this.activeFeed === source) this.channel.emit('update', { kind: 'snapshot', camera, topic });
      },
      event: (payload) => {
        const { camera_id: camera, type: topic } = payload;
        if (this.activeFeed !== source || typeof camera !== 'string' || !this.includes(camera) || typeof topic !== 'string') return;
        const now = Date.now();
        if (typeof payload.received_at === 'string') {
          const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('base64url');
          const delivered = this.recent.get(fingerprint);
          // WS and MQTT can deliver the same bridge event on opposite sides of a failover.
          if (delivered && delivered.source !== source && delivered.expires > now) return;
          this.recent.delete(fingerprint);
          this.recent.set(fingerprint, { source, expires: now + 10_000 });
          if (this.recent.size > 512) this.recent.delete(this.recent.keys().next().value!);
        }
        this.channel.emit('update', {
          kind: 'event', camera, topic, entry: { id: randomUUID(), observedAt: now, event: eventData({ raw: payload }) }
        });
      }
    };
  }

  private get cache() {
    const current = this.activeFeed ?? this.lastFeed;
    return current ? this.feeds.get(current)?.cache : undefined;
  }

  private inScope(camera: string) {
    return segment.test(camera) && (this.allowed.size === 0 || this.allowed.has(camera));
  }

  includes(camera: string) {
    return this.inScope(camera) && (!this.reportedIds || this.reportedIds.has(camera));
  }

  ids() {
    return this.reportedIds ? [...this.reportedIds] : (this.allowed.size ? [...this.allowed] : [...(this.cache?.keys() ?? [])]);
  }

  observe(listener: (update: BridgeUpdate) => void) {
    this.channel.on('update', listener);
    return () => this.channel.off('update', listener);
  }

  state(camera: string) {
    return this.cache?.get(camera) ?? new Map<string, Envelope>();
  }

  async command({ camera, id, command, correlation, capture = false }: {
    camera: string; id: string; command: Envelope; correlation: string; capture?: boolean
  }) {
    if (!this.includes(camera)) throw new Failure('CAMERA_UNKNOWN', 404);
    const route = capture ? this.config.capture : this.config.commands;
    if (route === 'mqtt') return this.broker.request({ camera, id, command, snapshot: capture });
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

  async callbacks(input: (
    | { action: 'list' }
    | { action: 'add' | 'update'; callback: { id: string; url: string; cameras: string[]; events: string[] } }
    | { action: 'remove'; id: string }
  ) & { correlation: string }) {
    if (!this.config.callbacks || !this.has('callbacks')) throw new Failure('UNSUPPORTED', 422);
    const request: Parameters<Bridge['api']>[0] = { path: '/callbacks', correlation: input.correlation };
    switch (input.action) {
      case 'list': break;
      case 'add':
        request.method = 'POST';
        request.data = input.callback;
        break;
      case 'update':
        request.path += '/' + input.callback.id;
        request.method = 'PUT';
        request.data = input.callback;
        break;
      case 'remove':
        request.path += '/' + input.id;
        request.method = 'DELETE';
        break;
    }
    try {
      const response = await this.api(request);
      const payload = record(await jsonResponse({ response }));
      if (typeof payload.ok === 'boolean') return payload;
    } catch (error) {
      if (error instanceof Failure) throw error;
    }
    if (input.action === 'list') throw new Failure('BRIDGE_UNAVAILABLE', 502);
    throw new Failure('OUTCOME_UNKNOWN', 502, 'unknown');
  }

  has(feature: 'v1' | 'media' | 'enrollment' | 'callbacks') {
    return this.bridgeVersion[feature];
  }

  canCapture(camera: string) {
    return this.config.capture === 'mqtt' && this.broker.includes(camera)
      && Boolean(this.state(camera).get('capabilities')?.baichuan);
  }

  streams(camera: string) {
    return this.has('media') ? this.mediaStreams.get(camera) ?? [] : [];
  }

  hasRecordings(camera: string) {
    return this.has('v1') && this.recordingCameras.has(camera);
  }

  hasPreview(camera: string) {
    return this.has('v1') && this.previewCameras.has(camera);
  }

  async api({ path, search, admin = false, data, correlation, ifNoneMatch, range, signal, method = data === undefined ? 'GET' : 'POST' }: {
    path: string; search?: string; admin?: boolean; data?: unknown; correlation?: string;
    ifNoneMatch?: string; range?: string; signal?: AbortSignal; method?: string
  }) {
    const link = this.http;
    if (!link || (admin && !link.adminToken)) throw new Failure('UNSUPPORTED', 422);
    try {
      return await request({
        link, path: '/api' + path, search, token: admin ? link.adminToken : undefined, method,
        data, correlation, ifNoneMatch, range, signal: signal ?? AbortSignal.timeout(admin ? 65_000 : 18_000)
      });
    } catch {
      if (method === 'GET' || method === 'HEAD') throw new Failure('BRIDGE_UNAVAILABLE', 502);
      throw new Failure('OUTCOME_UNKNOWN', 502, 'unknown');
    }
  }

  upstream(): Upstream {
    const connections: UpstreamConnection[] = [];
    const state = ({ connected }: { connected?: boolean }): ConnectionState => {
      if (connected === undefined) return 'checking';
      return connected ? 'online' : 'offline';
    };
    const { config } = this;

    if (config.http) {
      const uses: UpstreamConnection['uses'] = ['api'];
      if (config.commands === 'http') uses.push('commands');
      if (config.callbacks && this.has('callbacks')) uses.push('callbacks');
      connections.push({
        id: 'http', transport: config.http.url.protocol === 'https:' ? 'HTTPS' : 'HTTP',
        uses, state: state({ connected: this.httpState })
      });
    }
    const eventRole = ({ source }: { source: EventSource }): UpstreamConnection['feed'] => {
      if (this.feeds.size < 2 || !this.feeds.get(source)?.ready) return undefined;
      return this.activeFeed === source ? 'active' : 'standby';
    };
    const socket = this.feeds.get('ws');
    if (socket) {
      connections.push({
        id: 'ws', transport: socket.transport, uses: ['events'],
        state: state({ connected: socket.ready }), feed: eventRole({ source: 'ws' })
      });
    }
    const uses: UpstreamConnection['uses'] = [];
    if (this.feeds.has('mqtt')) uses.push('events');
    if (config.commands === 'mqtt') uses.push('commands');
    if (config.capture) uses.push('capture');
    if (!uses.length) uses.push('connectivity');
    connections.push({
      id: 'mqtt', transport: config.mqtt.url.protocol === 'mqtts:' ? 'MQTT TLS' : 'MQTT',
      uses, state: state({ connected: this.broker.ready }), feed: eventRole({ source: 'mqtt' })
    });
    return { id: config.id, label: config.label, connections };
  }

  scanInventory() {
    if (!this.bridgeVersion.inventory) return Promise.resolve(false);
    this.scanning ??= this.api({ path: '/inventory', signal: AbortSignal.timeout(2000) }).then(async response => {
      const inventory = record(await jsonResponse({ response })).cameras;
      if (!response.ok || !Array.isArray(inventory)) throw new Failure('BRIDGE_UNAVAILABLE', 502);
      const cameras = inventory.map(record).filter((item): item is Envelope & { id: string } => (
        typeof item.id === 'string' && this.inScope(item.id)
      )).slice(0, 128);
      const ids = new Set(cameras.map(camera => camera.id));
      const active = new Set(cameras.filter(camera => camera.active !== false).map(camera => camera.id));
      const mqttIds = this.config.mqtt.cameraIds?.filter(id => active.has(id)) ?? [...active];
      for (const { cache } of this.feeds.values()) {
        for (const id of cache.keys()) {
          if (!active.has(id)) cache.delete(id);
        }
      }
      const previous = this.reportedIds;
      this.reportedIds = ids;
      const topicsChanged = this.broker.setCameraIds(mqttIds);
      if (topicsChanged || !previous || ids.size !== previous.size || [...ids].some(id => !previous.has(id))) {
        this.channel.emit('update', { kind: 'feed' });
      }
      return true;
    }).finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  async refreshInventory() {
    if (this.http) {
      await this.check();
      if (await this.scanInventory()) return;
    }
    if (!this.feedReady) throw new Failure('BRIDGE_UNAVAILABLE', 502);
    if (this.socket?.ready) await this.socket.refreshSnapshots();
  }

  private updateContract(contract: Envelope) {
    const previous = JSON.stringify([this.bridgeVersion, [...this.mediaStreams], [...this.previewCameras], [...this.recordingCameras]]);
    const ok = contract.version === 1;
    this.bridgeVersion.v1 = ok;
    this.bridgeVersion.inventory = ok && contract.inventory === true;
    this.bridgeVersion.media = ok && this.config.http?.relay === true && contract.media === true;
    this.bridgeVersion.enrollment = ok && !!this.http?.adminToken && contract.enrollment === true;
    this.bridgeVersion.callbacks = ok && contract.callbacks === true;
    this.mediaStreams.clear();
    if (this.bridgeVersion.media) {
      for (const [camera, streams] of Object.entries(record(contract.mediaCameras))) {
        if (this.inScope(camera) && Array.isArray(streams)) {
          this.mediaStreams.set(camera, streams.filter(value => value === 'main' || value === 'sub'));
        }
      }
    }
    this.recordingCameras = new Set(ok && Array.isArray(contract.recordingsCameras)
      ? contract.recordingsCameras.slice(0,128).filter((camera): camera is string => typeof camera === 'string' && this.inScope(camera)) : []);
    this.previewCameras = new Set(ok && Array.isArray(contract.previewCameras) ? contract.previewCameras
      .slice(0, 128).filter((camera): camera is string => typeof camera === 'string' && this.inScope(camera)) : []);
    if (previous !== JSON.stringify([this.bridgeVersion, [...this.mediaStreams], [...this.previewCameras], [...this.recordingCameras]])) this.channel.emit('update', { kind: 'feed' });
    return ok;
  }

  private async checkHttp(link: Link) {
    try {
      const response = await this.api({ path: '/contract', signal: AbortSignal.timeout(2000) });
      if (response.ok) return this.updateContract(record(await jsonResponse({ response })));
      await response.body?.cancel();
      this.updateContract({});
      if (response.status !== 404) return false;
      // Older bridges can serve commands and exact MQTT topics without inventory discovery.
      const probe = await request({ link, path: '/livez', signal: AbortSignal.timeout(2000) });
      await probe.body?.cancel();
      return probe.ok;
    } catch {
      this.updateContract({});
      return false;
    }
  }

  async check() {
    if (this.http) this.httpState = await this.checkHttp(this.http);
    const knownInventory = this.reportedIds !== undefined || this.allowed.size > 0 || !!this.cache?.size || this.socket?.ready;
    return this.httpState !== false && !!knownInventory && this.feedReady && (this.config.commands !== 'mqtt' || this.broker.ready);
  }

  async close() {
    this.socket?.close();
    await Promise.all([this.broker.close(), this.http?.agent.destroy()]);
  }
}

const rejectedBeforeWrite = new Set([
  'CONTROL_ID_CONFLICT', 'CONTROL_VALIDATION_FAILED', 'CONTROL_TRANSPORT_DISABLED', 'CONTROL_QUEUE_UNAVAILABLE',
  'CONTROL_CAPABILITIES_UNAVAILABLE', 'CONTROL_UNSUPPORTED', 'CONTROL_SETTING_UNSUPPORTED',
  'PTZ_CAPABILITIES_UNAVAILABLE', 'PTZ_UNSUPPORTED', 'PTZ_TRANSPORT_DISABLED', 'PTZ_SPEED_UNSUPPORTED',
  'PTZ_ZOOM_OUT_OF_RANGE', 'PTZ_PRESET_UNKNOWN', 'PTZ_REQUEST_EXPIRED', 'PTZ_QUEUED_MOVE_CANCELLED',
  'SNAPSHOT_CAPTURE_BUSY', 'CALLBACK_CONFIG_INVALID', 'CALLBACK_UPDATE_MISSING', 'CALLBACK_REMOVE_MISSING',
  'CALLBACK_CONFIG_CHANGED', 'CALLBACK_DESTINATION_DENIED', 'API_SCOPE_DENIED'
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
