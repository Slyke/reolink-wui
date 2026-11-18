import { at, dispatcher, jsonResponse } from './net.js';
import { BrokerChannel, SocketChannel, connectionFailure, record, type ChannelChanges } from './bridge-channels.js';
import type { BridgeConfig } from './config.js';
import type { BridgeTest, ConnectionTest } from '../shared/bridges.js';
import { segment } from '../shared/urls.js';

const channelTest = ({ source, transport, open }: {
  source: 'ws' | 'mqtt'; transport: string;
  open: (changes: ChannelChanges) => { close: () => void | Promise<void> };
}) => new Promise<ConnectionTest>(resolve => {
  const began = Date.now();
  let channel: ReturnType<typeof open> | undefined;
  let finished = false;
  const finish = (status: ConnectionTest['status'], failure?: ConnectionTest['failure']) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    void Promise.resolve(channel?.close()).catch(() => {});
    return resolve({ source, transport, status, failure, elapsedMs: Date.now() - began });
  };
  const timer = setTimeout(() => finish('failed', 'timeout'), 5000);
  try {
    channel = open({
      connected: (ready, failure) => {
        if (ready) return finish('passed');
        if (failure) return finish('failed', failure);
      },
      refresh: () => {}, snapshot: () => {}, event: () => {}, gap: () => {}
    });
  } catch (error) { finish('failed', connectionFailure(error as Error)); }
});

// Probes use only API reads and event subscriptions. Draft settings are never persisted.
export const testBridge = async ({ config }: { config: BridgeConfig }): Promise<BridgeTest> => {
  const ids = new Set(config.cameraIds.length ? config.cameraIds : config.mqtt?.cameraIds ?? []);
  const http = config.http;
  let httpResult: ConnectionTest = { source: 'http', transport: 'HTTP', status: 'disabled', elapsedMs: 0 };
  if (http) {
    const began = Date.now();
    const agent = dispatcher(http);
    const get = (path: string) => {
      const options = {
        dispatcher: agent, redirect: 'error' as const, signal: AbortSignal.timeout(3500),
        headers: { authorization: 'Bearer ' + http.token }
      };
      return fetch(at({ base: http.url, path }), options);
    };
    httpResult = { source: 'http', transport: http.url.protocol === 'https:' ? 'HTTPS' : 'HTTP', status: 'failed', elapsedMs: 0 };
    try {
      const response = await get('/api/contract');
      const contract = record(await jsonResponse({ response }));
      if (!response.ok) httpResult.failure = [401,403].includes(response.status) ? 'authorization' : 'contract';
      else if (contract.version !== 1) httpResult.failure = 'contract';
      else {
        if (contract.inventory === true) {
          const inventory = await get('/api/inventory');
          if (!inventory.ok) throw new Error('Inventory unavailable');
          const cameras = record(await jsonResponse({ response: inventory })).cameras;
          if (!Array.isArray(cameras)) throw new Error('Invalid inventory');
          for (const item of cameras) {
            const camera = record(item);
            if (typeof camera.id === 'string' && segment.test(camera.id) && camera.active !== false
              && (!config.cameraIds.length || config.cameraIds.includes(camera.id))) ids.add(camera.id);
          }
        }
        httpResult.status = 'passed';
      }
    } catch (error) {
      httpResult.failure = (error as Error).name === 'TimeoutError' ? 'timeout'
        : connectionFailure(((error as Error).cause ?? error) as Error);
    } finally {
      httpResult.elapsedMs = Date.now() - began;
      await agent.destroy();
    }
  }
  const socket = config.ws ?? (http ? {
    url: at({ base: http.url, path: '/ws' }), token: http.token, ca: http.ca, rejectUnauthorized: http.rejectUnauthorized
  } : undefined);
  if (socket && !config.ws) socket.url.protocol = socket.url.protocol === 'https:' ? 'wss:' : 'ws:';
  const [ws, mqtt] = await Promise.all([
    socket ? channelTest({
      source: 'ws', transport: socket.url.protocol === 'wss:' ? 'WSS' : 'WS',
      open: changes => new SocketChannel(socket, [...ids], changes)
    }) : Promise.resolve<ConnectionTest>({ source: 'ws', transport: 'WS', status: 'disabled', elapsedMs: 0 }),
    config.mqtt ? channelTest({
      source: 'mqtt', transport: config.mqtt.url.protocol === 'mqtts:' ? 'MQTT TLS' : 'MQTT',
      open: changes => new BrokerChannel(config.mqtt!, config.mqtt?.cameraIds ?? [...ids], false, changes)
    }) : Promise.resolve<ConnectionTest>({ source: 'mqtt', transport: 'MQTT', status: 'disabled', elapsedMs: 0 })
  ]);
  return { results: [httpResult, ws, mqtt], cameraCount: ids.size };
};
