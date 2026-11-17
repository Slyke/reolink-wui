import { buildApiUrl } from '../../shared/urls.js';
import messages from './en-US.json';

export const t = (key: string, values: Record<string, string | number> = {}) => {
  const text = (messages as Record<string, string>)['reolink-wui-' + key] ?? key;
  return text.replace(/\{\$([A-Za-z0-9_]+)\}/g, (match, name: string) => String(values[name] ?? match));
};

export const url = (path: string) => buildApiUrl({
  url: path, apiBasePath: typeof document === 'undefined' ? '/api' : document.documentElement.dataset.apiBasePath
});

export class UiError extends Error {
  constructor(readonly reason: string, readonly correlation?: string) { super(reason); }
}

export type Outcome = { id?: string; outcome: string; data?: any; reason?: string; correlationId?: string; bridgeCorrelationId?: string };

export const api = async <T>({ path, method = 'GET', body, csrf, image = false, keepalive, signal }: {
  path: string; method?: string; body?: unknown; csrf?: string; image?: boolean; keepalive?: boolean; signal?: AbortSignal
}): Promise<T> => {
  try {
    const response = await fetch(url(path), {
      method, cache: 'no-store', keepalive, signal,
      headers: {
        accept: image ? 'image/png, image/jpeg' : 'application/json',
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (response.status === 204) return undefined as T;
    if (image && response.ok && ['image/png', 'image/jpeg'].includes(response.headers.get('content-type') ?? '')) return await response.blob() as T;
    const value = await response.json();
    if (!response.ok && !value.id) throw new UiError(value.reason ?? value.error ?? 'INTERNAL', value.correlationId ?? response.headers.get('x-correlation-id') ?? undefined);
    return value as T;
  } catch (error) {
    if (error instanceof UiError) throw error;
    throw new UiError('PROXY_UNAVAILABLE');
  }
};

export const fetchPreview = async ({ path, etag, signal }: {
  path: string; etag?: string; signal: AbortSignal
}): Promise<{ image?: Blob; etag?: string }> => {
  try {
    const response = await fetch(url(path), {
      cache: 'no-store', signal,
      headers: { accept: 'image/jpeg, image/png', ...(etag ? { 'if-none-match': etag } : {}) }
    });
    const nextEtag = response.headers.get('etag') ?? undefined;
    if (response.status === 304 && etag) return { etag: nextEtag ?? etag };
    if (response.ok && ['image/jpeg', 'image/png'].includes(response.headers.get('content-type') ?? '')) {
      return { image: await response.blob(), etag: nextEtag };
    }
    const value = await response.json();
    throw new UiError(value.reason ?? value.error ?? 'MEDIA_UNAVAILABLE', response.headers.get('x-correlation-id') ?? undefined);
  } catch (error) {
    if (error instanceof UiError) throw error;
    throw new UiError('PROXY_UNAVAILABLE');
  }
};

export const errorText = (error: unknown) => error instanceof UiError
  ? t('error-' + error.reason) + (error.correlation ? ' · ' + t('correlation') + ' ' + error.correlation : '')
  : t('error-INTERNAL');

export const outcomeText = (value: Outcome) => (
  (value.reason ? t('error-' + value.reason) : t(value.outcome))
  + (value.bridgeCorrelationId ? ' · ' + t('correlation') + ' ' + value.bridgeCorrelationId : '')
);

export const operationId = () => crypto.randomUUID();
