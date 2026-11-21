import { randomUUID } from 'node:crypto';
import type { ExternalType } from '../shared/sign-in.js';
import type { Config } from './config.js';
import { audit, type Account, type Sql } from './db.js';
import { Failure } from './errors.js';

export type ExternalIdentity = { kind: ExternalType; issuer: string; subject: string };

export function providers(config: Config): { kind: ExternalType; issuer: string }[] {
  const result: { kind: ExternalType; issuer: string }[] = [];
  if ('oidc' in config.auth) result.push({ kind: 'oauth', issuer: config.auth.oidc.issuer.href });
  if ('ingress' in config.auth) result.push({ kind: 'headers', issuer: config.auth.ingress.issuer });
  return result;
}

export function identityProvider(config: Config, kind?: ExternalType) {
  const available = providers(config);
  if (!kind && available.length > 1) throw new Failure('BAD_INPUT', 400);
  const provider = kind ? available.find(item => item.kind === kind) : available[0];
  if (!provider) throw new Failure('UNSUPPORTED', 422);
  return provider;
}

export async function classifyLegacyIdentities(query: Sql['query'], config: Config) {
  for (const provider of providers(config)) {
    await query("UPDATE identities SET kind=$1 WHERE kind='legacy' AND issuer=$2", provider.kind, provider.issuer);
  }
}

export async function linkedAccount(query: Sql['query'], identity: ExternalIdentity) {
  const [account] = await query<Account>(
    'SELECT a.id,a.label,a.admin,a.enabled FROM accounts a JOIN identities i ON i.account_id=a.id WHERE i.kind=$1 AND i.issuer=$2 AND i.subject=$3',
    identity.kind, identity.issuer, identity.subject);
  return account;
}

export async function linkIdentity(query: Sql['query'], identity: ExternalIdentity, id: string) {
  const [link] = await query<{ account_id: string }>(
    'INSERT INTO identities(kind,issuer,subject,account_id) VALUES ($1,$2,$3,$4) ON CONFLICT(kind,issuer,subject) DO UPDATE SET subject=excluded.subject RETURNING account_id',
    identity.kind, identity.issuer, identity.subject, id);
  if (link.account_id !== id) throw new Failure('IDENTITY_MISMATCH', 409);
}

export async function firstLoginAccount(query: Sql['query'], identity: ExternalIdentity, label: string, correlation: string) {
  const existing = await linkedAccount(query, identity);
  if (existing) {
    if (!existing.enabled) throw new Failure('ACCESS_DENIED', 403);
    return existing;
  }
  const account = { id: randomUUID(), label, enabled: 1, admin: 0 };
  await query('INSERT INTO accounts(id,label,enabled,admin) VALUES ($1,$2,1,0)', account.id, label);
  await linkIdentity(query, identity, account.id);
  await audit({ query, actor: account.id, resource: account.id, action: 'account.first-login', outcome: 'confirmed', correlation });
  return account;
}
