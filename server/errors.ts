import { randomUUID } from 'node:crypto';
import logger from './styleguide-logger.cjs';
import codes from './errors.json' with { type: 'json' };

export let logs = logger.debugAndErrors({ errorCodeMap: codes }) as {
  generateLog: (options: { caller: string; level: string; loggerKey: string; message: string; context?: object }) => unknown;
  generateError: (options: { caller: string; reason: string; errorKey: string; correlationId?: string; includeStackTrace: boolean; context?: object }) => unknown;
};
export const configureLogging = ({ logging }: { logging: Record<string,unknown> }) => {
  const gates = { OPERATION_UNVERIFIED: { level:'warn' }, ...(logging.gates as Record<string,unknown> ?? {}) };
  logs = logger.debugAndErrors({ settings: { logging: { ...logging,gates } }, errorCodeMap: codes });
};
export const recordError = ({ key, caller, correlationId = randomUUID(), context }: {
  key: keyof typeof codes; caller: string; correlationId?: string; context?: object
}) => logs.generateError({ caller, reason:key, errorKey:key, correlationId, context, includeStackTrace:false });

export const buildInfo = {
  service: 'reolink-wui',
  version: process.env.APP_VERSION ?? '0.1.0',
  buildHash: process.env.APP_BUILD_HASH ?? 'unknown',
  buildDate: process.env.APP_BUILD_DATE ?? 'unknown'
};

export class Failure extends Error {
  constructor(
    public key: keyof typeof codes,
    public status: number,
    public outcome?: string,
    public details?: { upstreamStatus?: number; bridgeCorrelationId?: string; playbackReason?: string }
  ) {
    super(key);
  }
}

export const boot = ({ caller }: { caller: string }) => logs.generateLog({
  caller, level: 'info', loggerKey: 'SERVICE_BOOT_DIAGNOSTICS', message: 'Reolink WUI started', context: buildInfo
});

export const report = ({ error, correlationId = randomUUID(), caller = 'api::request' }: {
  error: Failure; correlationId?: string; caller?: string;
}) => {
  const errorCode = codes[error.key];
  recordError({ key:error.key,caller,correlationId,context:{ httpStatus:error.status,...error.details } });
  return { error: error.key, errorKey: error.key, errorCode, correlationId, outcome: error.outcome, ...(error.details ? { details: error.details } : {}) };
};
