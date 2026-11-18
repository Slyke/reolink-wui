import type { capabilities, visibleState } from '../../server/cameras.js';
import type { Runtime } from '../../server/runtime.js';
import type { EventSource } from '../../shared/events.js';
import type { BridgeConnections } from '../../shared/bridges.js';

export type Camera = Awaited<ReturnType<Runtime['views']>>[number];
export type Caps = ReturnType<typeof capabilities>;
export type CameraDetail = ReturnType<typeof visibleState>;
export type { CameraEvent } from '../../server/cameras.js';
export type User = { id: string; label: string; admin: boolean };
export type SessionView = { user?: User; methods?: { local: boolean; oidc: boolean; proxy: boolean }; csrf?: string };
export type BridgeSummary = {
  id: string; label: string; connected: boolean; refreshedAt?: string | null; enrollment: boolean; callbacks: boolean;
  connections: BridgeConnections;
  eventSources: EventSource[]; availableEventSources: EventSource[];
};
export type CameraSummary = { id: string; bridge: string; label: string };
export type Account = { id: string; label: string; username?: string; admin: number; enabled: number };

export const cameraStatus = (camera: Camera) => camera.availability.stale ? 'stale'
  : (camera.availability.online === undefined ? 'waiting' : (camera.availability.online ? 'online' : 'offline'));
