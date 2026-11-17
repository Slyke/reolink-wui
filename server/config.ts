import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import JSON5 from 'json5';
import { z } from 'zod';
import { relativePrefix, segment } from '../shared/urls.js';
import { defaultEventRetention, maxEventRetention } from '../shared/events.js';
import { resolveReferences } from './references.js';

const object = z.strictObject;
const id = z.string().regex(segment).refine(value => !Object.hasOwn(Object.prototype, value));
const prefix = z.string().max(128).regex(relativePrefix);
const bearer = z.string().min(24).max(256).regex(/^[!-~]+$/);
const peer = z.string().refine(value => isIP(value) !== 0);
const tlsRoot = z.string().min(1).optional();
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
const endpoint = ({ secure, plain, originOnly = false }: { secure: string; plain?: string; originOnly?: boolean }) => (
  z.string().max(2048).url().transform(value => new URL(value)).refine(url => (
    !url.username && !url.password && !url.hash && !url.search && !/%|\\/.test(url.pathname)
    && (url.protocol === secure || (url.protocol === plain && loopback(url.hostname)))
    && (!originOnly || (url.pathname === '/' || url.pathname === ''))
  ))
);

const ingress = object({
  peers: z.array(peer).min(1).max(16),
  secret: bearer,
  issuer: z.string().min(1).max(200),
  identityHeader: z.string().regex(/^remote-[a-z0-9-]+$/).default('remote-user')
});
const forward = object({ secret: bearer, peers: z.array(peer).min(1).max(16), ca: tlsRoot });

const oidc = object({
  issuer: endpoint({ secure: 'https:', plain: 'http:' }),
  clientId: z.string().min(1).max(200),
  clientSecret: bearer,
  tokenEndpointAuth: z.enum(['client_secret_basic', 'client_secret_post']).default('client_secret_basic'),
  ca: tlsRoot
});

const auth = z.discriminatedUnion('mode', [
  object({ mode: z.literal('local') }),
  object({ mode: z.literal('oidc'), oidc }),
  object({ mode: z.literal('oidc+local'), oidc }),
  object({ mode: z.literal('proxy-headers'), ingress }),
  object({ mode: z.literal('proxy-headers+local'), ingress })
]);

const database = z.discriminatedUnion('driver', [
  object({ driver: z.literal('sqlite'), path: z.string().min(1) }),
  object({
    driver: z.literal('postgres'),
    url: z.string().url().refine(value => {
      const url = new URL(value);
      return ['postgres:', 'postgresql:'].includes(url.protocol) && !url.search && !url.hash;
    }),
    tls: z.union([object({ ca: tlsRoot }), z.literal(false)])
  }).refine(value => value.tls !== false || loopback(new URL(value.url).hostname))
]);

const retention = z.number().int().min(0).max(maxEventRetention).default(defaultEventRetention);
const eventHistory = z.discriminatedUnion('backend', [
  object({ backend: z.literal('memory'), retention }),
  object({
    backend: z.literal('valkey'), retention, ca: tlsRoot,
    keyPrefix: z.string().max(80).regex(/^[a-zA-Z0-9:_-]+$/).default('reolink-wui'),
    url: z.string().max(2048).url().transform(value => new URL(value)).refine(url =>
      !url.hash && !url.search && !!url.hostname && /^\/?\d*$/.test(url.pathname)
      && (url.protocol === 'rediss:' || (url.protocol === 'redis:' && loopback(url.hostname)))
    )
  })
]);

const http = object({
  url: endpoint({ secure: 'https:', plain: 'http:' }),
  token: bearer,
  ca: tlsRoot,
  adminToken: bearer.optional(),
  relay: z.boolean().default(true)
});
const ws = object({ url: endpoint({ secure: 'wss:', plain: 'ws:' }), token: bearer, ca: tlsRoot });
const eventTransport = z.enum(['ws', 'mqtt']);
const mqtt = object({
  url: endpoint({ secure: 'mqtts:', plain: 'mqtt:', originOnly: true }),
  cameraIds: z.array(id).min(1).max(128).refine(unique).optional(),
  baseTopic: z.string().max(160).regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  ca: tlsRoot,
  allowPartialTrustChain: z.boolean().default(false)
}).refine(value => Boolean(value.username) === Boolean(value.password))
  .refine(value => !value.allowPartialTrustChain || (value.url.protocol === 'mqtts:' && Boolean(value.ca)));

const bridge = object({
  id,
  label: z.string().min(1).max(80),
  cameraIds: z.array(id).max(128).refine(unique).default([]),
  commands: z.enum(['http', 'mqtt']),
  events: z.union([eventTransport, object({ primary: eventTransport, secondary: eventTransport.optional() })]).optional(),
  capture: z.literal('mqtt').optional(),
  http: http.optional(),
  ws: ws.optional(),
  mqtt,
  callbacks: z.record(id, endpoint({ secure: 'https:', plain: 'http:' })).optional()
}).transform(value => {
  const defaults = value.ws || value.http
    ? { primary: 'ws' as const, secondary: 'mqtt' as const }
    : { primary: 'mqtt' as const };
  const events = value.events ?? defaults;
  return { ...value, events: typeof events === 'string' ? { primary: events } : events };
}).superRefine((value, ctx) => {
  const { primary, secondary } = value.events;
  const usesWs = primary === 'ws' || secondary === 'ws';
  if (primary === secondary) {
    ctx.addIssue({ code: 'custom', path: ['events', 'secondary'], message: 'Choose a different secondary transport' });
  }
  if (usesWs && !value.http && !value.ws) {
    ctx.addIssue({ code: 'custom', path: ['ws'], message: 'Set a WebSocket or bridge HTTP endpoint' });
  }
  if ((value.commands === 'http' || value.callbacks) && !value.http) {
    ctx.addIssue({ code: 'custom', path: ['http'], message: 'HTTP commands and callbacks require a bridge HTTP endpoint' });
  }
  if (!value.http && !usesWs && !(value.mqtt.cameraIds ?? value.cameraIds).length) {
    ctx.addIssue({ code: 'custom', path: ['mqtt', 'cameraIds'], message: 'Set exact MQTT camera IDs or configure a bridge endpoint for discovery' });
  }
  if (value.cameraIds.length && value.mqtt.cameraIds?.some(id => !value.cameraIds.includes(id))) {
    ctx.addIssue({ code: 'custom', path: ['mqtt', 'cameraIds'], message: 'Use camera IDs in the bridge scope' });
  }
  if (value.http?.adminToken && value.http.adminToken === value.http.token) {
    ctx.addIssue({ code: 'custom', message: 'Administrative token must be separate' });
  }
});

export const configSchema = object({
  publicOrigin: endpoint({ secure: 'https:', plain: 'http:', originOnly: true }),
  httpApi: object({
    mode: z.enum(['browser', 'proxy']).default('browser'),
    browserBasePath: prefix.default('/api'),
    proxy: object({
      basePath: prefix.default('/api-proxy'),
      upstreamBaseUrl: endpoint({ secure: 'https:', plain: 'http:' }).nullable().default(null),
      upstreamBasePath: prefix.default('/api')
    }).default({ basePath: '/api-proxy', upstreamBaseUrl: null, upstreamBasePath: '/api' })
  }).default({ mode: 'browser', browserBasePath: '/api', proxy: { basePath: '/api-proxy', upstreamBaseUrl: null, upstreamBasePath: '/api' } }),
  listen: object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(8080),
    tls: object({
      cert: z.string().min(1).optional(),
      key: z.string().min(1).optional(),
      serverNames: z.array(z.string().regex(/^[a-zA-Z0-9.:-]+$/)).max(16).default([])
    }).refine(value => Boolean(value.cert) === Boolean(value.key)).optional()
  }).default({ host: '127.0.0.1', port: 8080 }),
  forward: forward.optional(),
  auth,
  database,
  eventHistory: eventHistory.default({ backend: 'memory', retention: defaultEventRetention }),
  sessionMinutes: z.number().int().min(5).max(1440).default(480),
  localSessionMinutes: z.number().int().min(5).max(365 * 24 * 60).optional(),
  bridges: z.array(bridge).max(32).refine(value => unique(value.map(item => item.id))).default([])
}).superRefine((value, ctx) => {
  if (value.httpApi.mode === 'proxy' && (!value.httpApi.proxy.upstreamBaseUrl || !value.forward)) {
    ctx.addIssue({ code: 'custom', path: ['httpApi'], message: 'Proxy mode requires an authenticated upstream hop' });
  }
  if ('ingress' in value.auth && value.forward?.secret === value.auth.ingress.secret) {
    ctx.addIssue({ code: 'custom', path: ['forward'], message: 'Ingress and server hop keys must be different' });
  }
});

export type Config = z.infer<typeof configSchema>;
export type BridgeConfig = Config['bridges'][number];

export const readConfig = ({ path = process.env.WUI_CONFIG ?? './local-only/wui.json5' } = {}): Config => {
  let parsed: unknown;
  try {
    parsed = JSON5.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('WUI config missing, unreadable, or invalid JSON5');
  }
  const validated = configSchema.safeParse(resolveReferences({ value: parsed, configPath: path }));
  if (!validated.success) {
    throw new Error('Invalid WUI config fields: ' + validated.error.issues.map(issue => issue.path.join('.') || '$').join(', '));
  }
  return validated.data;
};

export const browserPath = ({ config }: { config: Config }) => config.httpApi.mode === 'proxy'
  ? config.httpApi.proxy.basePath
  : config.httpApi.browserBasePath;

export const wirePath = ({ config }: { config: Config }) => config.httpApi.mode === 'proxy'
  ? config.httpApi.proxy.upstreamBasePath
  : config.httpApi.browserBasePath;
