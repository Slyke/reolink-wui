export const logicalApi = '/api';

export function recordingReturnPath(value: string | null, origin: string) {
  if (!value || value.length > 2048) return;
  try {
    const target = new URL(value, origin);
    if (target.origin === origin && target.pathname === '/recordings') return target.pathname + target.search;
  } catch { /* Invalid return links use the normal landing page. */ }
}

export const relativePrefix = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
export const segment = /^[A-Za-z0-9_-]{1,64}$/;
export const correlationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const suffixAt = ({ path, prefix }: { path: string; prefix: string }) => (
  path === prefix ? '' : (path.startsWith(prefix + '/') ? path.slice(prefix.length) : null)
);

export const buildApiUrl = ({ url, apiBasePath = '/api' }: { url: string; apiBasePath?: string }) => {
  const suffix = suffixAt({ path: url, prefix: logicalApi });
  return suffix === null ? url : apiBasePath + suffix;
};
