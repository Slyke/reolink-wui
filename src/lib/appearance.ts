import { appearanceOverrides, type Appearance } from '../../shared/appearance.js';

const legacyKeys = {
  palette: 'd4rk-styleguide-palette',
  theme: 'd4rk-styleguide-theme',
  font: 'd4rk-styleguide-font',
  contentWidth: 'd4rk-styleguide-content-width'
} as const;

export const appearanceStorageKey = ({ account }: { account: string }) => 'reolink-wui:appearance:' + account;

export const readPersonalAppearance = ({ account }: { account: string }): Partial<Appearance> => {
  try {
    const key = appearanceStorageKey({ account });
    const stored = localStorage.getItem(key);
    if (stored !== null) return appearanceOverrides(JSON.parse(stored));
    const cookies = new Map(document.cookie.split('; ').map(entry => {
      const separator = entry.indexOf('=');
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
    const legacy = appearanceOverrides(Object.fromEntries(Object.entries(legacyKeys).map(([field, name]) => [
      field, localStorage.getItem(name) ?? cookies.get(name) ?? (field === 'theme' ? localStorage.getItem('reolink-wui-theme') : null)
    ])));
    if (Object.keys(legacy).length === 0) return legacy;
    localStorage.setItem(key, JSON.stringify(legacy));
    for (const name of Object.values(legacyKeys)) {
      localStorage.removeItem(name);
      document.cookie = name + '=; Path=/; Max-Age=0; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    }
    localStorage.removeItem('reolink-wui-theme');
    return legacy;
  } catch {
    return {};
  }
};

export const savePersonalAppearance = ({ account, choices }: { account: string; choices: Partial<Appearance> }) => {
  try {
    localStorage.setItem(appearanceStorageKey({ account }), JSON.stringify(choices));
  } catch { /* Apply the choice in the current tab if browser storage is unavailable. */ }
};
