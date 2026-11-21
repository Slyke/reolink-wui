import { argon2, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyRequest, FastifyReply } from 'fastify';
import * as oidc from 'openid-client';
import { browserPath, type Config } from './config.js';
import type { Account, Sql, Session } from './db.js';
import { firstLoginAccount, type ExternalIdentity } from './identities.js';
import type { GroupPolicy } from '../shared/sign-in.js';
import { readPolicy, effectivePolicy, policyKey, userInfo, verifyGroup, recheckInterval, member, openAccessToken, sealAccessToken, type GroupProof } from './oidc-groups.js';
import { audit } from './db.js';
import { Failure, recordError } from './errors.js';
import { dispatcher } from './net.js';
import { recordingReturnPath } from '../shared/urls.js';
import { forwardProofHeader, verifiedIdentityHeader, ingressSubject, samePeer, sameSecret, subject } from './trusted-proxy.js';

export const hash = ({ value }: { value: string }) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
const sessionCookie = '__Host-reolink_session';
const flowCookie = '__Host-reolink_oidc';
const argon = promisify(argon2);
let activeHashes = 0;

const derive = async ({ password, nonce }: { password: string; nonce: Buffer }) => {
  if (activeHashes >= 4) throw new Failure('LOGIN_LIMIT', 429);
  activeHashes++;
  try {
    return await argon('argon2id', { message: password, nonce, parallelism: 1, passes: 3, memory: 65_536, tagLength: 32 });
  } finally {
    activeHashes--;
  }
};

export const passwordHash = async ({ password }: { password: string }) => {
  if (password.length < 12 || Buffer.byteLength(password) > 1024) throw new Failure('BAD_INPUT', 400);
  const nonce = randomBytes(16);
  const tag = await derive({ password, nonce });
  return 'argon2id-v1:' + nonce.toString('base64url') + ':' + tag.toString('base64url');
};

const checkPassword = async ({ password, encoded }: { password: string; encoded?: string }) => {
  const [, salt, digest] = encoded?.split(':') ?? [];
  const nonce = salt ? Buffer.from(salt, 'base64url') : Buffer.alloc(16);
  const expected = digest ? Buffer.from(digest, 'base64url') : Buffer.alloc(32);
  if (nonce.length !== 16 || expected.length !== 32) return false;
  const matches = timingSafeEqual(await derive({ password, nonce }), expected);
  return Boolean(encoded) && matches;
};

const cookie = ({ request, name }: { request: FastifyRequest; name: string }) => {
  const matching = request.headers.cookie?.split(';').map(item => item.trim()).filter(item => item.startsWith(name + '=')) ?? [];
  const token = matching.length === 1 ? matching[0].slice(name.length + 1) : undefined;
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
};
const setCookie = ({ reply, name, value, seconds }: { reply: FastifyReply; name: string; value: string; seconds: number }) => (
  reply.header('set-cookie', name + '=' + value + '; Path=/; Max-Age=' + seconds + '; Secure; HttpOnly; SameSite=Lax')
);
const one = ({ request, name }: { request: FastifyRequest; name: string }) => {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
};

export const csrfToken = ({ token }: { token: string }) => hash({ value: 'csrf:' + token });
export const isLocal = ({ config }: { config: Config }) => config.auth.mode === 'local' || config.auth.mode.endsWith('+local');

export class Auth {
  private readonly rate = new Map<string, { count: number; until: number }>();
  private readonly groupChecks = new Map<string, Promise<boolean>>();
  private oidcClient?: oidc.Configuration;
  private readonly agent;
  private discovering?: Promise<oidc.Configuration>;

  constructor(readonly config: Config, readonly sql: Sql) {
    if ('oidc' in config.auth) this.agent = dispatcher({ ca: config.auth.oidc.ca });
  }

  private async discover() {
    if (this.oidcClient) return this.oidcClient;
    if (this.discovering) return this.discovering;
    const config = this.config.auth;
    if (!('oidc' in config)) throw new Failure('UNSUPPORTED', 422);
    const { issuer, clientId, clientSecret, tokenEndpointAuth } = config.oidc;
    const customFetch: oidc.CustomFetch = (input, options) => {
      const url = new URL(input);
      if (url.origin !== issuer.origin || url.username || url.password) throw new Error('Untrusted OIDC endpoint');
      const request = {
        ...options, dispatcher: this.agent, redirect: 'error'
      };
      return fetch(url, request as RequestInit);
    };
    const extras = issuer.protocol === 'http:' ? [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks] : [oidc.enableNonRepudiationChecks];
    this.discovering = oidc.discovery(
      issuer, clientId, { client_secret: clientSecret },
      tokenEndpointAuth === 'client_secret_basic' ? oidc.ClientSecretBasic(clientSecret) : oidc.ClientSecretPost(clientSecret),
      { [oidc.customFetch]: customFetch, execute: extras, timeout: 4 }
    );
    try {
      const client = await this.discovering;
      const actual = new URL(client.serverMetadata().issuer);
      if (actual.href !== issuer.href || new URL(client.serverMetadata().authorization_endpoint ?? '').origin !== issuer.origin) {
        throw new Error('Invalid discovery identity');
      }
      this.oidcClient = client;
      return client;
    } finally {
      this.discovering = undefined;
    }
  }

  async ready() {
    if (!('oidc' in this.config.auth)) return true;
    try { await this.discover(); return true; } catch { return false; }
  }

  close() { return this.agent?.destroy(); }

  forwarded({ request }: { request: FastifyRequest }) {
    const hop = this.config.forward;
    return !!hop && samePeer({ address: request.raw.socket.remoteAddress, peers: hop.peers })
      && sameSecret({ supplied: one({ request, name: forwardProofHeader }), expected: hop.secret });
  }

  private proxyIdentity({ request }: { request: FastifyRequest }) {
    if (!('ingress' in this.config.auth)) return undefined;
    return this.config.httpApi.mode === 'proxy'
      ? (this.forwarded({ request }) ? subject({ value: one({ request, name: verifiedIdentityHeader }) }) : undefined)
      : ingressSubject({ auth: this.config.auth, address: request.raw.socket.remoteAddress, get: name => one({ request, name }) });
  }

  requireOrigin({ request }: { request: FastifyRequest }) {
    if (request.headers.origin !== this.config.publicOrigin.origin || request.headers['sec-fetch-site'] === 'cross-site') {
      throw new Failure('CSRF_DENIED', 403);
    }
  }

  throttle({ request, name, method }: { request: FastifyRequest; name: string; method: string }) {
    const now = Date.now();
    for (const [key, value] of this.rate) if (value.until <= now) this.rate.delete(key);
    for (const [key, limit] of [
      [method + ':instance', 150], [method + ':account:' + hash({ value: name }), 12],
      [method + ':ip:' + (request.raw.socket.remoteAddress ?? ''), 100]
    ] as const) {
      const entry = this.rate.get(key) ?? { count: 0, until: now + 60_000 };
      if (entry.count >= limit || this.rate.size >= 2000) throw new Failure('LOGIN_LIMIT', 429);
      entry.count++;
      this.rate.set(key, entry);
    }
  }

  async session({ request }: { request: FastifyRequest }) {
    const token = cookie({ request, name: sessionCookie });
    if (!token) return undefined;
    const sessionId = hash({ value: token });
    const [row] = await this.sql.query<Session & {
      group_policy: string | null; oidc_group_policy: string | null; group_checked: number | string | null; group_token: string | null
    }>(
      `SELECT a.id,a.label,a.admin,a.enabled,s.expires,s.method,s.issuer,s.subject,s.group_policy,s.group_checked,s.group_token,p.oidc_group_policy
       FROM sessions s JOIN accounts a ON s.account_id=a.id CROSS JOIN instance_settings p
       WHERE s.id=$1 AND s.expires>$2 AND a.enabled=1 AND p.id=1
       AND (s.method='local' OR EXISTS (SELECT 1 FROM identities i WHERE i.kind=CASE s.method WHEN 'oidc' THEN 'oauth' ELSE 'headers' END
         AND i.issuer=s.issuer AND i.subject=s.subject AND i.account_id=a.id))`,
      sessionId, Date.now()
    );
    if (!row) return undefined;
    const { group_policy, group_checked, group_token, oidc_group_policy, ...account } = row;
    if ((account.method === 'local' && !isLocal({ config: this.config }))
      || (account.method === 'oidc' && (!('oidc' in this.config.auth) || new URL(account.issuer ?? 'https://invalid.invalid').href !== this.config.auth.oidc.issuer.href))) return undefined;
    if (account.method === 'oidc' && 'oidc' in this.config.auth) {
      const policy = effectivePolicy(this.config, oidc_group_policy);
      if (policyKey(policy) !== group_policy) return undefined;
      if (group_policy && group_token && Date.now() - Number(group_checked) >= recheckInterval) {
        let check = this.groupChecks.get(sessionId);
        if (!check) {
          check = this.recheckGroup(sessionId, token, group_token, account.subject!, policy, request.id)
            .finally(() => this.groupChecks.delete(sessionId));
          this.groupChecks.set(sessionId, check);
        }
        if (!await check) return undefined;
      }
    }
    if (account.method === 'proxy' && (account.subject !== this.proxyIdentity({ request }) || !('ingress' in this.config.auth)
      || account.issuer !== this.config.auth.ingress.issuer)) return undefined;
    return { token, account };
  }

  private async recheckGroup(id: string, cookie: string, encrypted: string, subject: string, policy: GroupPolicy, correlation: string) {
    const client = await this.discover();
    const info = await userInfo(client, openAccessToken(encrypted, cookie), subject);
    if (!member(info.groups, policy)) {
      await this.sql.query('DELETE FROM sessions WHERE id=$1', id);
      recordError({ key: 'OIDC_GROUP_REQUIRED', caller: 'auth::recheckGroup', correlationId: correlation });
      return false;
    }
    const updated = await this.sql.query('UPDATE sessions SET group_checked=$1 WHERE id=$2 AND group_policy=$3 AND expires>$1 RETURNING id',
      Date.now(), id, policyKey(policy));
    return updated.length === 1;
  }

  async require({ request, mutate = false }: { request: FastifyRequest; mutate?: boolean }) {
    const session = await this.session({ request });
    if (!session) throw new Failure('NOT_AUTHENTICATED', 401);
    if (mutate) {
      this.requireOrigin({ request });
      if (!sameSecret({ supplied: one({ request, name: 'x-csrf-token' }), expected: csrfToken({ token: session.token }) })) {
        throw new Failure('CSRF_DENIED', 403);
      }
    }
    return session;
  }

  methods({ request }: { request: FastifyRequest }) {
    return {
      local: isLocal({ config: this.config }),
      oidc: 'oidc' in this.config.auth,
      proxy: Boolean(this.proxyIdentity({ request }))
    };
  }

  private async begin(request: FastifyRequest, reply: FastifyReply, login:
    { method: 'local'; account: Account } | { method: 'proxy' | 'oidc'; identity: ExternalIdentity; label: string; proof?: GroupProof }) {
    const old = cookie({ request, name: sessionCookie });
    const token = randomToken();
    const { localSessionMinutes, sessionMinutes } = this.config;
    const minutes = login.method === 'local' ? (localSessionMinutes ?? sessionMinutes) : sessionMinutes;
    const proof = login.method === 'oidc' ? login.proof : undefined;
    const now = Date.now();
    const expires = Math.min(now + minutes * 60_000, proof?.expires ?? Infinity);
    if (expires <= now) throw new Failure('OIDC_FAILED', 401);
    const account = await this.sql.transaction(async query => {
      if (login.method === 'oidc' && policyKey(await readPolicy(this.config, query)) !== (proof ? policyKey(proof.policy) : null)) {
        throw new Failure('OIDC_GROUP_REQUIRED', 403);
      }
      const identity = login.method === 'local' ? undefined : login.identity;
      const account = login.method === 'local'
        ? (await query<Account>('SELECT id,label,admin,enabled FROM accounts WHERE id=$1 AND enabled=1', login.account.id))[0]
        : await firstLoginAccount(query, login.identity, login.label, request.id);
      if (!account) throw new Failure('ACCESS_DENIED', 403);
      const oldId = old ? hash({ value: old }) : '';
      const [previous] = old ? await query<{ account_id: string }>('SELECT account_id FROM sessions WHERE id=$1 AND expires>$2', oldId, now) : [];
      if (previous && previous.account_id !== account.id) throw new Failure('IDENTITY_MISMATCH', 409);
      await query('DELETE FROM sessions WHERE expires <= $1 OR id=$2', now, oldId);
      await query('INSERT INTO sessions(id,account_id,method,issuer,subject,expires,group_policy,group_checked,group_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        hash({ value: token }), account.id, login.method, identity?.issuer ?? null, identity?.subject ?? null, expires,
        proof ? policyKey(proof.policy) : null, proof ? now : null, proof?.access ? sealAccessToken(proof.access, token) : null);
      await audit({ query, actor: account.id, resource: 'session', action: 'sign-in', outcome: 'confirmed', correlation: request.id });
      return account;
    });
    setCookie({ reply, name: sessionCookie, value: token, seconds: Math.ceil((expires - now) / 1000) });
    return { user: { id: account.id, label: account.label, admin: account.admin === 1 }, csrf: csrfToken({ token }) };
  }

  async local({ request, reply, username, password }: {
    request: FastifyRequest; reply: FastifyReply; username: string; password: string
  }) {
    if (!isLocal({ config: this.config })) throw new Failure('UNSUPPORTED', 422);
    this.requireOrigin({ request });
    this.throttle({ request, name: username, method: 'local' });
    const [account] = await this.sql.query<Account & { password_hash: string }>(
      'SELECT * FROM accounts WHERE username=$1 AND enabled=1', username
    );
    if (!await checkPassword({ password, encoded: account?.password_hash }) || !account) {
      await audit({ query: this.sql.query, resource: 'session', action: 'sign-in', outcome: 'rejected', correlation: request.id });
      throw new Failure('LOGIN_INVALID', 401);
    }
    return this.begin(request, reply, { account, method: 'local' });
  }

  proxy({ request, reply }: { request: FastifyRequest; reply: FastifyReply }) {
    this.requireOrigin({ request });
    const subject = this.proxyIdentity({ request });
    if (!subject || !('ingress' in this.config.auth)) throw new Failure('NOT_AUTHENTICATED', 401);
    this.throttle({ request, name: subject, method: 'proxy' });
    return this.begin(request, reply, { method: 'proxy', label: subject, identity: { kind: 'headers', issuer: this.config.auth.ingress.issuer, subject } });
  }

  private callback() {
    return this.config.publicOrigin.origin + browserPath({ config: this.config }) + '/v1/session/oidc/callback';
  }

  async oidcStart({ request, reply }: { request: FastifyRequest; reply: FastifyReply }) {
    this.throttle({ request, name: 'oidc', method: 'oidc' });
    const client = await this.discover().catch(() => { throw new Failure('OIDC_FAILED', 502); });
    const origin = this.config.publicOrigin.origin;
    const next = recordingReturnPath(new URL(request.url,origin).searchParams.get('next'),origin) ?? null;
    const token = randomToken();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    await this.sql.transaction(async query => {
      await query('DELETE FROM oidc_flows WHERE expires <= $1 OR id=$2',
        Date.now(), hash({ value: cookie({ request, name: flowCookie }) ?? token }));
      await query('INSERT INTO oidc_flows(id,state,nonce,verifier,expires,return_path) VALUES ($1,$2,$3,$4,$5,$6)',
        hash({ value: token }), state, nonce, verifier, Date.now() + 300_000, next);
    });
    setCookie({ reply, name: flowCookie, value: token, seconds: 300 });
    const scopes = new Set(['openid']);
    if ('oidc' in this.config.auth) for (const scope of this.config.auth.oidc.scopes) scopes.add(scope);
    if ('oidc' in this.config.auth && this.config.auth.oidc.groupScope && (await readPolicy(this.config, this.sql.query)).requiredGroups.length) {
      scopes.add(this.config.auth.oidc.groupScope);
    }
    return reply.redirect(oidc.buildAuthorizationUrl(client, {
      redirect_uri: this.callback(), scope: [...scopes].join(' '),
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce
    }).toString(), 303);
  }

  async oidcFinish({ request, reply }: { request: FastifyRequest; reply: FastifyReply }) {
    const token = cookie({ request, name: flowCookie });
    if (!token) throw new Failure('OIDC_FAILED', 400);
    const [flow] = await this.sql.query<{ state: string; nonce: string; verifier: string; return_path: string | null }>(
      'DELETE FROM oidc_flows WHERE id=$1 AND expires>$2 RETURNING state,nonce,verifier,return_path', hash({ value: token }), Date.now()
    );
    setCookie({ reply, name: flowCookie, value: '', seconds: 0 });
    if (!flow) throw new Failure('OIDC_FAILED', 400);
    const client = await this.discover().catch(() => { throw new Failure('OIDC_FAILED', 502); });
    const current = new URL(this.callback());
    current.search = new URL(request.url, 'http://localhost').search;
    const tokens = await oidc.authorizationCodeGrant(client, current, {
      expectedState: flow.state, expectedNonce: flow.nonce, pkceCodeVerifier: flow.verifier, idTokenExpected: true
    }).catch(() => { throw new Failure('OIDC_FAILED', 401); });
    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== 'string' || !claims.sub.length || claims.sub.length > 180) throw new Failure('OIDC_FAILED', 401);
    const policy = await readPolicy(this.config, this.sql.query);
    const gated = policy.requiredGroups.length > 0;
    const metadata = client.serverMetadata();
    let info: oidc.UserInfoResponse | undefined;
    if (metadata.userinfo_endpoint && (gated || (!claims.name && !claims.preferred_username && metadata.scopes_supported?.includes('profile')))) {
      try {
        info = await userInfo(client, tokens.access_token, claims.sub);
      } catch (error) {
        if (gated) throw error;
        recordError({ key: 'OIDC_FAILED', caller: 'auth::userInfo', correlationId: request.id });
      }
    }
    const proof = gated ? verifyGroup(policy, claims, info, tokens.access_token, tokens.expiresIn()) : undefined;
    const label = [info?.name, claims.name, info?.preferred_username, claims.preferred_username].find(
      (value): value is string => typeof value === 'string' && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value));
    await this.begin(request, reply, { method: 'oidc', identity: { kind: 'oauth', issuer: new URL(claims.iss).href, subject: claims.sub },
      label: label?.trim().slice(0,80) || claims.sub, proof });
    return reply.redirect(recordingReturnPath(flow.return_path,this.config.publicOrigin.origin) ?? '/', 303);
  }

  async logout({ request, reply }: { request: FastifyRequest; reply: FastifyReply }) {
    const session = await this.require({ request, mutate: true });
    await this.sql.query('DELETE FROM sessions WHERE id=$1', hash({ value: session.token }));
    setCookie({ reply, name: sessionCookie, value: '', seconds: 0 });
  }
}
