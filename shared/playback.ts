import { aiClasses } from './access.js';

export const defaultPreviewIntervalMs = 5000;
export const bridgePreviewPollIntervalMs = 2000;
export const minPreviewIntervalMs = 50;
export const maxPreviewIntervalMs = 2_147_483_647; // The browser's maximum setTimeout delay.

export const previewAlerts = ['off', 'any', 'motion', ...aiClasses] as const;
export type PreviewAlert = typeof previewAlerts[number];

export const matchesPreviewAlert = ({ selected, event }: {
  selected: PreviewAlert; event: { type?: string; active?: boolean; objects?: { class?: string }[] };
}) => selected !== 'off' && event.active === true
  && (selected === 'any' || selected === event.type || !!event.objects?.some(object => object.class === selected));
