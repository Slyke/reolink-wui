import type { BridgeConnections } from '../shared/bridges.js';
import type { BridgeConfig } from './config.js';
import { record } from './bridge-channels.js';

export const bridgeConnections = (config: BridgeConfig, effectiveCameraReadRetries?: number): BridgeConnections => ({
  cameraReadRetries: config.cameraReadRetries, effectiveCameraReadRetries,
  id: config.id, label: config.label, cameraIds: [...config.cameraIds], commands: config.commands, capture: config.capture,
  ...(config.http ? { http: {
    url: config.http.url.href, ca: config.http.ca, rejectUnauthorized: config.http.rejectUnauthorized, relay: config.http.relay,
    tokenConfigured: Boolean(config.http.token)
  } } : {}),
  ...(config.ws ? { ws: { url: config.ws.url.href, ca: config.ws.ca, rejectUnauthorized: config.ws.rejectUnauthorized, tokenConfigured: Boolean(config.ws.token) } } : {}),
  ...(config.mqtt ? { mqtt: {
    url: config.mqtt.url.href, baseTopic: config.mqtt.baseTopic, cameraIds: config.mqtt.cameraIds,
    username: config.mqtt.username, ca: config.mqtt.ca, rejectUnauthorized: config.mqtt.rejectUnauthorized, allowPartialTrustChain: config.mqtt.allowPartialTrustChain,
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
    for (const secret of ['token','password']) {
      if (!Object.hasOwn(supplied,secret) && typeof saved[secret] === 'string') fields[secret] = saved[secret];
      if (fields[secret] === '') delete fields[secret];
    }
    // On an explicit save/test with HTTP enabled, custom WebSockets share its PSK.
    if (transport === 'ws' && value.http && !Object.hasOwn(supplied,'token')) delete fields.token;
    merged[transport] = fields;
  }
  return merged;
};
