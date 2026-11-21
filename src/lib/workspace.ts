import { getContext } from 'svelte';
import type { Permission } from '../../shared/access.js';
import type { Appearance } from '../../shared/appearance.js';
import type { Account, BridgeSummary, CameraSummary, User } from './models.js';

export type SignedIn = { user: User; csrf: string };
export type WorkspaceContext = { lastFrames:Map<string,Blob>; current: () => SignedIn; refreshSession: () => Promise<void> };
export type AppearanceContext = {
  current: () => Appearance;
  customized: () => boolean;
  reset: () => void;
  setAccount: ({ id }: { id?: string }) => void;
  replaceDefaults: ({ appearance }: { appearance: Appearance }) => void;
  choose: ({ key, value }: { key: keyof Appearance; value: string }) => void;
};
export type AdminData = {
  accounts: Account[];
  bridges: BridgeSummary[];
  cameras: CameraSummary[];
  grants: { account_id: string; camera_id: string; permissions: Permission[] }[];
  local: boolean;
  external: boolean;
  appearanceDefaults: Appearance;
  inventoryIntervalSeconds: number;
};

export const workspaceKey = Symbol('workspace');
export const appearanceKey = Symbol('appearance');
export const useWorkspace = () => getContext<WorkspaceContext>(workspaceKey);
export const useAppearance = () => getContext<AppearanceContext>(appearanceKey);

export type AdminContext = {
  current: () => AdminData;
  busy: () => boolean;
  refresh: () => Promise<void>;
  mutate: (options: { suffix: string; body: object; method?: string; announce?: boolean }) => Promise<boolean>;
};
export const adminKey = Symbol('administration');
export const useAdministration = () => getContext<AdminContext>(adminKey);
