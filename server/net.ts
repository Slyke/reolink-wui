import { getCACertificates } from 'node:tls';
import { Agent } from 'undici';
import { Failure } from './errors.js';

export const trust = ({ ca }: { ca?: string }) => ca ? [...getCACertificates('default'), ca] : undefined;

export const dispatcher = ({ ca, rejectUnauthorized = true }: { ca?: string; rejectUnauthorized?: boolean }) => new Agent({
  connect: { ca: trust({ ca }), rejectUnauthorized, timeout: 3500 },
  headersTimeout: 130_000, bodyTimeout: 45_000,
  connections: 24
});

export const at = ({ base, path, search = '' }: { base: URL; path: string; search?: string }) => {
  const target = new URL(base);
  target.pathname = base.pathname.replace(/\/$/, '') + path;
  target.search = search;
  return target;
};

export const responseBytes = async ({ response, limit = 2_000_000 }: { response: Response; limit?: number }) => {
  if (!response.body) throw new Failure('BRIDGE_UNAVAILABLE', 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Failure('BRIDGE_UNAVAILABLE', 502);
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
  }
};

export const jsonResponse = async (options: Parameters<typeof responseBytes>[0]): Promise<unknown> => (
  JSON.parse((await responseBytes(options)).toString('utf8'))
);
