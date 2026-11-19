import { z } from 'zod';

export type Preset = { id: number; name?: string };
const slot = z.number().int().min(0).max(255);
export const presetPreferences = z.strictObject({
  order: z.array(slot).max(256).refine(ids => new Set(ids).size === ids.length),
  returnPreset: slot.nullable(),
  returnSeconds: z.number().int().min(1).max(86400)
});
export type PresetPreferences = z.infer<typeof presetPreferences>;
export const defaultPresetPreferences = (): PresetPreferences => ({ order: [], returnPreset: null, returnSeconds: 10 });
export const readPresetPreferences = (value: string | null): PresetPreferences =>
  value ? presetPreferences.parse(JSON.parse(value)) : defaultPresetPreferences();
export function orderedPresets(presets: Preset[], order: number[]) {
  const ranks = new Map(order.map((id, index) => [id, index]));
  return [...presets].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) || a.id - b.id);
}
