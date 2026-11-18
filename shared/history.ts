import { z } from 'zod';
import { defaultEventRetention, maxEventRetention } from './events.js';

export const valkeySchema = z.strictObject({
  url: z.string().max(2048).url().transform(value => new URL(value)).refine(url =>
    !url.hash && !url.search && !!url.hostname && /^\/?\d*$/.test(url.pathname)
    && ['redis:', 'rediss:'].includes(url.protocol)
  ),
  keyPrefix: z.string().max(80).regex(/^[a-zA-Z0-9:_-]+$/).default('reolink-wui'),
  ca: z.string().min(1).max(65_536).optional(),
  rejectUnauthorized: z.boolean().default(true),
  maxEvents: z.number().int().min(0).max(1_000_000).nullable().optional(),
  ttlSeconds: z.number().int().min(1).max(365 * 86400).nullable().optional()
}).refine(value => value.maxEvents !== null || Boolean(value.ttlSeconds), {
  path: ['ttlSeconds'], message: 'Set a count limit or event lifetime'
});
const retention = z.number().int().min(0).max(maxEventRetention).default(defaultEventRetention);
export const eventHistorySchema = z.discriminatedUnion('backend', [
  z.strictObject({ backend: z.literal('memory'), retention }),
  valkeySchema.safeExtend({ backend: z.literal('valkey'), retention })
]);
export const historyStorageSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('defaults'), valkey: valkeySchema.optional() }),
  z.strictObject({ mode: z.literal('memory'), valkey: valkeySchema.optional() }),
  z.strictObject({ mode: z.literal('valkey'), valkey: valkeySchema })
]);
export const historyStorageInput = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('defaults') }),
  z.strictObject({ mode: z.literal('memory') }),
  z.strictObject({
    mode: z.literal('valkey'),
    valkey: valkeySchema.safeExtend({ password: z.string().max(512).optional() })
  })
]);
export type HistoryConfig = z.infer<typeof eventHistorySchema>;
export type HistoryStorage = z.infer<typeof historyStorageSchema>;
export type HistoryStorageInput = z.infer<typeof historyStorageInput>;
export type Valkey = z.infer<typeof valkeySchema>;
export type ValkeyView = {
  url: string; keyPrefix: string; ca?: string; rejectUnauthorized: boolean; passwordConfigured: boolean;
  maxEvents?: number | null; ttlSeconds?: number | null;
};
export type HistorySettings = {
  backend: 'memory' | 'valkey'; limit: number; connected: boolean;
  storage: { mode: HistoryStorage['mode']; valkey?: ValkeyView };
  defaults: { backend: 'memory' | 'valkey'; valkey?: ValkeyView };
};
