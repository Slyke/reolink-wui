export const defaultInventoryIntervalSeconds = 10;
export const minInventoryIntervalSeconds = 1;
export const maxInventoryIntervalSeconds = 86400;

export type Transport = 'HTTP' | 'HTTPS' | 'MQTT' | 'MQTT TLS';
export type ConnectionUse = 'commands' | 'events' | 'capture' | 'callbacks' | 'api';
export type ConnectionState = 'checking' | 'online' | 'offline';

export type UpstreamConnection = {
  id: string;
  transport: Transport;
  uses: ConnectionUse[];
  state: ConnectionState;
};

export type Upstream = {
  id: string;
  label: string;
  connections: UpstreamConnection[];
};

export type InventoryState = 'no-bridge' | 'waiting' | 'empty' | 'discovered';
