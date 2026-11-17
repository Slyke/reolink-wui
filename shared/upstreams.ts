export const defaultInventoryIntervalSeconds = 10;
export const minInventoryIntervalSeconds = 1;
export const maxInventoryIntervalSeconds = 86400;

export type Transport = 'HTTP' | 'HTTPS' | 'WS' | 'WSS' | 'MQTT' | 'MQTT TLS';
export type ConnectionUse = 'commands' | 'events' | 'capture' | 'callbacks' | 'api' | 'connectivity';
export type ConnectionState = 'checking' | 'online' | 'offline';

export type UpstreamConnection = {
  id: string;
  transport: Transport;
  uses: ConnectionUse[];
  state: ConnectionState;
  feed?: 'active' | 'standby';
};

export type Upstream = {
  id: string;
  label: string;
  connections: UpstreamConnection[];
};

export type InventoryState = 'no-bridge' | 'waiting' | 'empty' | 'discovered';
