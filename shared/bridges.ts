export type BridgeConnections = {
  id: string; label: string; cameraIds: string[]; commands?: 'http' | 'mqtt'; capture?: 'mqtt';
  http?: { url: string; ca?: string; relay: boolean; tokenConfigured: boolean; adminTokenConfigured: boolean };
  ws?: { url: string; ca?: string; tokenConfigured: boolean };
  mqtt?: {
    url: string; baseTopic: string; cameraIds?: string[]; username?: string; ca?: string;
    allowPartialTrustChain: boolean; passwordConfigured: boolean;
  };
  callbacks: Record<string, string>;
};
