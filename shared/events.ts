export const defaultEventRetention = 100;
export const maxEventRetention = 1000;
export const maxFeedGapReports = 6;
export const maxFeedGapSamples = 8;

export type FeedConnectionFailure = 'tls' | 'authorization' | 'subscription' | 'transport';

type DetectedGap = { id: string; detectedAt: number };
type ConnectionGap = DetectedGap & { recoveredAt?: number };
type BridgeSource = { bridge: string; transport: 'MQTT' | 'MQTT TLS' };
type MissedEvent = { camera: string; type?: string; observedAt: number };

export type FeedGap =
  | (DetectedGap & { cause: 'unknown' })
  | (ConnectionGap & { cause: 'browser-connection' })
  | (ConnectionGap & BridgeSource & { cause: 'bridge-connection'; failure: FeedConnectionFailure })
  | (DetectedGap & {
    cause: 'delivery-backlog';
    firstObservedAt: number;
    lastObservedAt: number;
    droppedEvents: number;
    samples: MissedEvent[];
  });
