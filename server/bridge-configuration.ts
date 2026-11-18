import type { BridgeConnections } from '../shared/bridges.js';
import type { BridgeConfig } from './config.js';
import { record } from './bridge-channels.js';

export const bridgeConnections = (config: BridgeConfig): BridgeConnections => ({
  id: config.id, label: config.label, cameraIds: [...config.cameraIds], commands: config.commands, capture: config.capture,
  ...(config.http ? { http: {
    url: config.http.url.href, ca: config.http.ca, relay: config.http.relay,
    tokenConfigured: Boolean(config.http.token), adminTokenConfigured: Boolean(config.http.adminToken)
  } } : {}),
  ...(config.ws ? { ws: { url: config.ws.url.href, ca: config.ws.ca, tokenConfigured: Boolean(config.ws.token) } } : {}),
  ...(config.mqtt ? { mqtt: {
    url: config.mqtt.url.href, baseTopic: config.mqtt.baseTopic, cameraIds: config.mqtt.cameraIds,
    username: config.mqtt.username, ca: config.mqtt.ca, allowPartialTrustChain: config.mqtt.allowPartialTrustChain,
    passwordConfigured: Boolean(config.mqtt.password)
  } } : {}),
  callbacks: Object.fromEntries(Object.entries(config.callbacks ?? {}).map(([name,url]) => [name,url.href]))
});

export const mergeBridgeCredentials = ({ value, previous, id }: { value: Record<string, unknown>; previous?: BridgeConfig; id?: string }) => {
  const merged: Record<string, unknown> = { ...value, ...(id ? { id } : {}) };
  for (const transport of ['http','ws','mqtt'] as const) {
    if (!Object.hasOwn(value,transport)) continue;
    const supplied = record(value[transport]);
    const saved = record(previous?.[transport]);
    const fields = { ...supplied };
    for (const secret of ['token','adminToken','password']) {
      if (!Object.hasOwn(supplied,secret) && typeof saved[secret] === 'string') fields[secret] = saved[secret];
      if (fields[secret] === '') delete fields[secret];
    }
    merged[transport] = fields;
  }
  return merged;
};
