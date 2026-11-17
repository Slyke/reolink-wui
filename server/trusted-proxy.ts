import { createHash, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';

export const verifiedIdentityHeader = 'x-wui-forwarded-subject';
export const ingressProofHeader = 'x-wui-ingress-proof';
export const forwardProofHeader = 'x-wui-forward-proof';

export const sameSecret = ({ supplied, expected }: { supplied?: string; expected: string }) => (
  supplied !== undefined && timingSafeEqual(
    createHash('sha256').update(supplied).digest(), createHash('sha256').update(expected).digest()
  )
);

export const samePeer = ({ address, peers }: { address?: string; peers: string[] }) => {
  const normalized = address?.replace(/^::ffff:/, '');
  return peers.some(peer => peer.replace(/^::ffff:/, '') === normalized);
};

export const subject = ({ value }: { value?: string }) => (value && /^[^\x00-\x20\x7f,]{1,180}$/.test(value) ? value : undefined);

export const ingressSubject = ({ auth, address, get }: {
  auth: Config['auth']; address?: string; get: (header: string) => string | undefined
}) => {
  if (!('ingress' in auth)) return undefined;
  const policy = auth.ingress;
  if (!samePeer({ address, peers: policy.peers }) || !sameSecret({ supplied: get(ingressProofHeader), expected: policy.secret })) return undefined;
  return subject({ value: get(policy.identityHeader) });
};
