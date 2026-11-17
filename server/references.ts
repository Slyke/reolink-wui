import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, relative, sep, win32 } from 'node:path';

export const resolveReferences = ({ value, configPath, env = process.env }: {
  value: unknown; configPath: string; env?: NodeJS.ProcessEnv;
}): unknown => {
  let directory: string | undefined;
  const visit = ({ value, location }: { value: unknown; location: string }): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => visit({ value: item, location: location + '[' + index + ']' }));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key, visit({ value: item, location: location + '.' + JSON.stringify(key) })
      ]));
    }
    if (typeof value !== 'string') return value;
    const variable = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (variable) return env[variable[1]] ?? null;
    const file = /^\$\{file:([^{}]*)\}$/.exec(value);
    if (!file) return value;
    try {
      const reference = file[1];
      const fromEnv = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(reference);
      const path = fromEnv ? env[fromEnv[1]] : reference;
      if (!path || win32.parse(path).root || path.includes('\0') || path.split(/[\\/]/).filter(part => part === '..').length > 1) throw new Error();
      directory ??= realpathSync(dirname(resolve(configPath)));
      const parent = dirname(directory);
      if (parent === directory) throw new Error();
      const root = dirname(parent) === parent ? directory : parent;
      const inside = (candidate: string) => {
        const suffix = relative(root, candidate);
        return suffix && suffix !== '..' && !suffix.startsWith('..' + sep);
      };
      const requested = resolve(directory, path);
      if (!inside(requested)) throw new Error();
      const canonical = realpathSync(requested);
      if (!inside(canonical) || !statSync(canonical).isFile()) throw new Error();
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(canonical));
    } catch {
      throw new Error('Invalid file reference ' + JSON.stringify(file[1]) + ' at ' + location);
    }
  };
  return visit({ value, location: '$' });
};
