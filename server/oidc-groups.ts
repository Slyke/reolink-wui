import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import * as oidc from 'openid-client';
import type { GroupPolicy } from '../shared/sign-in.js';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import { Failure } from './errors.js';

export const recheckInterval = 60_000;
const tokenOnlyLifetime = 300_000;

export function effectivePolicy(config: Config, stored: string | null): GroupPolicy {
  if ('oidc' in config.auth && config.auth.oidc.requiredGroups !== undefined) {
    const { requiredGroups, requiredGroupsMode } = config.auth.oidc;
    return { requiredGroups, requiredGroupsMode };
  }
  return stored ? JSON.parse(stored) : { requiredGroups: [], requiredGroupsMode: 'any' };
}

export async function readPolicy(config: Config, query: Sql['query']) {
  const [settings] = await query<{ oidc_group_policy: string | null }>('SELECT oidc_group_policy FROM instance_settings WHERE id=1');
  return effectivePolicy(config, settings.oidc_group_policy);
}

export const policyKey = (policy: GroupPolicy) => policy.requiredGroups.length
  ? JSON.stringify({ requiredGroups: [...policy.requiredGroups].sort(), requiredGroupsMode: policy.requiredGroupsMode }) : null;

export function member(groups: unknown, policy: GroupPolicy) {
  if (!Array.isArray(groups) || !groups.every(group => typeof group === 'string')) return false;
  const matches = (group: string) => groups.includes(group);
  return policy.requiredGroupsMode === 'all' ? policy.requiredGroups.every(matches) : policy.requiredGroups.some(matches);
}

export async function userInfo(client: oidc.Configuration, access: string, subject: string) {
  try {
    return await oidc.fetchUserInfo(client, access, subject);
  } catch {
    throw new Failure('OIDC_FAILED', 502);
  }
}

export type GroupProof = { policy: GroupPolicy; expires: number; access?: string };

export function verifyGroup(policy: GroupPolicy, claims: oidc.IDToken, info: oidc.UserInfoResponse | undefined,
  access: string, lifetime: number | undefined): GroupProof {
  const fromUserInfo = info !== undefined && Object.hasOwn(info, 'groups');
  if (!member(fromUserInfo ? info.groups : claims.groups, policy)) throw new Failure('OIDC_GROUP_REQUIRED', 403);
  const now = Date.now();
  const expires = fromUserInfo && lifetime !== undefined ? now + lifetime * 1000 : claims.exp * 1000;
  return { policy, expires: fromUserInfo ? expires : Math.min(expires, now + tokenOnlyLifetime),
    access: fromUserInfo ? access : undefined };
}

// Only the browser's opaque session cookie can decrypt this session's server-side UserInfo token.
const encryptionKey = (cookie: string) => createHmac('sha256', cookie).update('reolink-wui:oidc-userinfo:v1').digest();
export function sealAccessToken(access: string, cookie: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(cookie), iv);
  const ciphertext = Buffer.concat([cipher.update(access, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}
export function openAccessToken(encrypted: string, cookie: string) {
  const data = Buffer.from(encrypted, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(cookie), data.subarray(0,12));
  decipher.setAuthTag(data.subarray(12,28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}
