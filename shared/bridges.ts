export type BridgeConnections = {
  id: string; label: string; cameraIds: string[]; commands?: 'http' | 'mqtt'; capture?: 'mqtt';
  http?: { url: string; ca?: string; rejectUnauthorized: boolean; relay: boolean; tokenConfigured: boolean };
  ws?: { url: string; ca?: string; rejectUnauthorized: boolean; tokenConfigured: boolean };
  mqtt?: {
    url: string; baseTopic: string; cameraIds?: string[]; username?: string; ca?: string;
    rejectUnauthorized: boolean; allowPartialTrustChain: boolean; passwordConfigured: boolean;
  };
  callbacks: Record<string, string>;
};

export type ConnectionTest = {
  source: 'http' | 'ws' | 'mqtt'; transport: string; status: 'passed' | 'failed' | 'disabled';
  elapsedMs: number; failure?: 'tls' | 'authorization' | 'subscription' | 'heartbeat' | 'transport' | 'timeout' | 'contract';
};
export type BridgeTest = { results: ConnectionTest[]; cameraCount: number };
