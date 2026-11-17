import { building } from '$app/environment';
import type { Handle } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import type { Agent } from 'undici';
import { suffixAt } from '../shared/urls.js';
import { readConfig } from '../server/config.js';
import { at, dispatcher } from '../server/net.js';
import { boot, buildInfo, Failure, report } from '../server/errors.js';
import { forwardProofHeader, verifiedIdentityHeader, ingressSubject } from '../server/trusted-proxy.js';

const config = building ? undefined : readConfig();
const agent = config?.httpApi.mode === 'proxy' ? dispatcher({ ca: config.forward?.ca }) : undefined;
if (config) {
  if ('ingress' in config.auth && process.env.ADDRESS_HEADER) throw new Error('Proxy identity requires adapter-node socket addresses');
  boot({ caller: 'ui::start' });
}

const requestHeaders = ['accept', 'content-type', 'cookie', 'if-none-match', 'range', 'last-event-id', 'origin', 'referer', 'sec-fetch-site', 'x-csrf-token'];
const noBody = new Set([204, 205, 304]);
const drop = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'host', 'content-encoding', 'set-cookie'
]);

export const handle: Handle = async ({ event, resolve }) => {
  const { url, request, getClientAddress } = event;
  const correlationId = randomUUID();
  if (url.pathname === '/livez' || (url.pathname === '/readyz' && config?.httpApi.mode === 'browser')) {
    return Response.json({ ...buildInfo, ok: true, correlationId }, { headers: { 'cache-control': 'no-store', 'x-correlation-id': correlationId } });
  }
  if (config?.httpApi.mode !== 'proxy' || !config.httpApi.proxy.upstreamBaseUrl || !config.forward) return resolve(event);
  const { basePath, upstreamBasePath, upstreamBaseUrl } = config.httpApi.proxy;
  const suffix = suffixAt({ path: url.pathname, prefix: basePath });
  const ready = url.pathname === '/readyz';
  if (suffix === null && !ready) return resolve(event);
  const fail = (error: Failure) => Response.json(
    report({ error, correlationId, caller: 'ui::proxy' }),
    { status: error.status, headers: { 'cache-control': 'no-store', 'x-correlation-id': correlationId } }
  );
  if (suffix !== null && !/^(\/[A-Za-z0-9_-]+)*\/?$/.test(suffix)) return fail(new Failure('PROXY_PATH_INVALID', 400));
  const headers = new Headers();
  const requestConnection = request.headers.get('connection')?.split(',').map(name => name.trim().toLowerCase()) ?? [];
  for (const name of requestHeaders) {
    const value = request.headers.get(name);
    if (value !== null && !requestConnection.includes(name)) headers.set(name, value);
  }
  const peer = getClientAddress();
  const subject = ingressSubject({ auth: config.auth, address: peer, get: name => request.headers.get(name) ?? undefined });
  if (subject) headers.set(verifiedIdentityHeader, subject);
  headers.set(forwardProofHeader, config.forward.secret);
  headers.set('x-correlation-id', correlationId);
  headers.set('x-forwarded-host', config.publicOrigin.host);
  headers.set('x-forwarded-proto', config.publicOrigin.protocol.slice(0, -1));
  headers.set('x-forwarded-for', peer);

  try {
    const options: RequestInit & { dispatcher?: Agent; duplex?: 'half' } = {
      method: request.method, headers, body: request.body, duplex: 'half', redirect: 'manual',
      signal: ready ? AbortSignal.timeout(3500) : request.signal, dispatcher: agent
    };
    const response = await fetch(at({
      base: upstreamBaseUrl, path: ready ? '/readyz' : upstreamBasePath + suffix, search: ready ? '' : url.search
    }), options);
    const connection = response.headers.get('connection')?.split(',').map(name => name.trim().toLowerCase()) ?? [];
    const responseHeaders = new Headers();
    for (const [name, value] of response.headers) if (!drop.has(name) && !connection.includes(name)) responseHeaders.append(name, value);
    for (const value of response.headers.getSetCookie()) responseHeaders.append('set-cookie', value);
    responseHeaders.set('x-correlation-id', correlationId);
    return new Response(noBody.has(response.status) ? null : response.body, {
      status: response.status, statusText: response.statusText, headers: responseHeaders
    });
  } catch {
    return fail(new Failure('PROXY_UNAVAILABLE', 502));
  }
};
