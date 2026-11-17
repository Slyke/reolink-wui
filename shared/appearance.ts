export const palettes = ['d4rk', 'terminal', 'bubbly', 'paper', 'ocean', 'retro', 'professional', 'reference', 'contrast', 'tron'] as const;
export const modes = ['dark', 'light'] as const;
export const widths = ['min', '1080', 'standard', '1440', '1920', 'full'] as const;
export const fontGroups = [
  { label: 'font-sans', options: ['system-sans', 'segoe-ui', 'arial', 'verdana', 'trebuchet-ms'] },
  { label: 'font-serif', options: ['system-serif', 'georgia', 'palatino', 'times-new-roman'] },
  { label: 'font-system', options: ['system-stack', 'ui-mono', 'generic-mono'] },
  { label: 'font-macos', options: ['sf-mono', 'menlo', 'monaco'] },
  { label: 'font-windows', options: ['cascadia-mono', 'consolas', 'lucida-console', 'courier-new'] },
  { label: 'font-android', options: ['roboto-mono', 'droid-sans-mono'] },
  { label: 'font-linux', options: ['noto-sans-mono', 'ubuntu-mono', 'dejavu-sans-mono', 'liberation-mono'] }
] as const;
export const fonts = fontGroups.flatMap(group => [...group.options]);
export type Appearance = { palette: string; theme: string; font: string; contentWidth: string };

export const defaultAppearance: Appearance = { palette: 'd4rk', theme: 'dark', font: 'system-stack', contentWidth: 'standard' };
const appearanceOptions = { palette: palettes, theme: modes, font: fonts, contentWidth: widths };

export const appearanceOverrides = (value: unknown): Partial<Appearance> => {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(appearanceOptions).flatMap(([key, options]) => {
    const choice = record[key];
    return typeof choice === 'string' && (options as readonly string[]).includes(choice) ? [[key, choice]] : [];
  }));
};
