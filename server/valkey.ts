import { Redis } from 'ioredis';
import type { Valkey, ValkeyTestResult } from '../shared/history.js';
import { recordError } from './errors.js';

type Connection = Pick<Valkey, 'url' | 'ca' | 'rejectUnauthorized'>;
type TestFailure = Extract<ValkeyTestResult, { connected: false }>['failure'];

export const valkeyClient = (config: Connection, reconnect: boolean) => new Redis(config.url.href, {
  ...(config.url.protocol === 'rediss:' ? { tls: { ca: config.ca, rejectUnauthorized: config.rejectUnauthorized } } : {}),
  lazyConnect: true, connectTimeout: 2000, commandTimeout: 2000, enableReadyCheck: false,
  enableOfflineQueue: false, autoResendUnfulfilledCommands: false, maxRetriesPerRequest: 0,
  retryStrategy: () => reconnect ? 1500 : null
});

const failureReason = (error: unknown): TestFailure => {
  if (!(error instanceof Error)) return 'transport';
  const code = (error as NodeJS.ErrnoException).code ?? '';
  if (/WRONGPASS|NOAUTH|NOPERM|invalid (username-password pair|password)/i.test(error.message)) return 'authorization';
  if (/DB index|invalid DB|SELECT is not allowed/i.test(error.message)) return 'database';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'dns';
  if (/CERT|TLS|SSL|ISSUER|SIGNATURE|EPROTO/.test(code)) return 'tls';
  if (/TIME(?:DOUT|OUT)/i.test(code) || /timed? ?out/i.test(error.message)) return 'timeout';
  return 'transport';
};

export const testValkey = async (config: Connection, correlationId: string): Promise<ValkeyTestResult> => {
  const started = performance.now();
  const client = valkeyClient(config, false);
  let connectionError: Error | undefined;
  client.on('error', error => { connectionError ??= error; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ping = async () => {
    await client.connect();
    const database = Number(config.url.pathname.slice(1));
    if (database) await client.select(database);
    if (await client.ping() !== 'PONG') throw new Error('Unexpected PING reply');
  };
  try {
    await Promise.race([
      ping(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out')), 5000); })
    ]);
    return { connected: true, elapsedMs: Math.round(performance.now() - started) };
  } catch (error) {
    const failure = failureReason(connectionError ?? error);
    recordError({ key: 'EVENT_HISTORY_CONNECTION_FAILED', caller: 'history::test', correlationId, context: { failure } });
    return { connected: false, failure };
  } finally {
    clearTimeout(timer);
    client.disconnect();
  }
};
