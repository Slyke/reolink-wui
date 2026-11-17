import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { launch, hop, localPassword, publicOrigin } from './support.mjs';

const secret = 'fixture-ingress-proof-token-long';
const ingress = { issuer:'test-ingress', peers:['127.0.0.1'], secret };
const secretOidc = 'fixture-oidc-verifier-secret-long';

const provider = async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength:2048 });
  const wrong = generateKeyPairSync('rsa', { modulusLength:2048 }).privateKey;
  const header = Buffer.from(JSON.stringify({alg:'RS256',kid:'test',typ:'JWT'})).toString('base64url');
  let expected, fault;
  const server = createServer(async (req,res) => {
    res.setHeader('content-type','application/json');
    if (req.url === '/.well-known/openid-configuration') {
      return res.end(JSON.stringify({
        issuer, authorization_endpoint:issuer+'/authorization', token_endpoint:issuer+'/token', jwks_uri:issuer+'/jwks',
        response_types_supported:['code'], grant_types_supported:['authorization_code'], subject_types_supported:['public'],
        id_token_signing_alg_values_supported:['RS256'], code_challenge_methods_supported:['S256'],
        token_endpoint_auth_methods_supported:['client_secret_basic']
      }));
    }
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys:[{...publicKey.export({format:'jwk'}),alg:'RS256',kid:'test',use:'sig'}] }));
    if (req.url === '/token') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const fields = new URLSearchParams(Buffer.concat(chunks).toString());
      if (!expected || decodeURIComponent(Buffer.from(req.headers.authorization?.replace(/^Basic /i,'') ?? '', 'base64').toString()) !== 'wui:' + secretOidc
        || fields.get('code') !== 'fixture-code' || fields.get('redirect_uri') !== expected.get('redirect_uri')
        || createHash('sha256').update(fields.get('code_verifier') ?? '').digest('base64url') !== expected.get('code_challenge')) {
        res.statusCode=400; return res.end('{"error":"invalid_grant"}');
      }
      const now = Math.floor(Date.now()/1000);
      const payload = Buffer.from(JSON.stringify({
        iss:fault==='issuer' ? issuer+'/wrong' : issuer, sub:'stable-subject', aud:fault==='audience'?'wrong':'wui', iat:now-10,
        exp:fault==='expired'?now-300:now+90, nonce:fault==='nonce'?'wrong':expected.get('nonce')
      })).toString('base64url');
      const message = header+'.'+payload;
      const signature = sign('RSA-SHA256',Buffer.from(message),fault==='signature'?wrong:privateKey).toString('base64url');
      return res.end(JSON.stringify({access_token:'fixture-not-for-wui',token_type:'Bearer',id_token:message+'.'+signature}));
    }
    res.statusCode=404; res.end('{}');
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const issuer = 'http://127.0.0.1:'+server.address().port;
  return {
    issuer, set:(request,error) => {expected=request;fault=error;},
    close: () => new Promise(resolve => {server.closeAllConnections();server.close(() => resolve());})
  };
};

test('password sign-in can have a longer session lifetime than proxy sign-in', async t => {
  const sessionMinutes = 60;
  const localSessionMinutes = 10080;
  const { app, runtime, seed, incoming } = await launch({
    auth: { mode: 'proxy-headers+local', ingress },
    sessionMinutes,
    localSessionMinutes
  });
  t.after(() => app.close());
  const accountId = await seed({ username: 'localuser', issuer: ingress.issuer, subject: 'subject-one' });

  const started = Date.now();
  const local = await incoming({
    method: 'POST', path: '/session/local', payload: { username: 'localuser', password: localPassword }
  });
  assert.equal(local.statusCode, 200, local.body);
  assert.equal(local.cookies[0].maxAge, localSessionMinutes * 60);

  const [session] = await runtime.sql.query(
    'SELECT expires FROM sessions WHERE account_id=$1 AND method=$2', accountId, 'local'
  );
  const lifetimeMs = localSessionMinutes * 60_000;
  assert.ok(session.expires >= started + lifetimeMs && session.expires <= Date.now() + lifetimeMs);

  const proxy = await incoming({
    method: 'POST', path: '/session/proxy',
    headers: { 'remote-user': 'subject-one', 'x-wui-ingress-proof': secret }
  });
  assert.equal(proxy.statusCode, 200, proxy.body);
  assert.equal(proxy.cookies[0].maxAge, sessionMinutes * 60);
});

for (const proxy of [false,true]) {
  for (const mode of ['local','oidc','oidc+local','proxy-headers','proxy-headers+local']) {
    test('sign-in mode ' + mode + ' through ' + (proxy ? 'private proxy hop' : 'browser route'), async t => {
      const oidc = mode.startsWith('oidc') ? await provider() : undefined;
      if (oidc) t.after(() => oidc.close());
      const auth = oidc ? {mode,oidc:{issuer:oidc.issuer,clientId:'wui',clientSecret:secretOidc}}
        : (mode.startsWith('proxy-headers') ? { mode, ingress } : { mode });
      const { app, seed, incoming, signIn, base } = await launch({ auth, proxy });
      t.after(() => app.close());
      const details = (await incoming({ path:'/session' })).json();
      assert.equal(details.methods.local, mode==='local'||mode.endsWith('+local'));
      assert.equal(details.methods.oidc,!!oidc);
      if (details.methods.local) {
        await seed({username:'localuser'});
        const local = await signIn('localuser');
        assert.equal((await incoming({path:'/cameras',headers:local})).statusCode,200);
      }
      if (proxy) assert.equal((await app.inject(base+'/session')).statusCode,403);
      if (mode.startsWith('proxy-headers')) {
        const subject = await seed({issuer:ingress.issuer,subject:'subject-one'});
        await seed({issuer:ingress.issuer,subject:'subject-two'});
        const call = headers => incoming({method:'POST',path:'/session/proxy',headers});
        const real = proxy ? { 'x-wui-forwarded-subject':'subject-one' } : {'remote-user':'subject-one','x-wui-ingress-proof':secret };
        assert.equal((await app.inject({method:'POST',url:base+'/session/proxy',headers:{origin:publicOrigin,'remote-user':'subject-one','x-wui-forwarded-subject':'subject-one'}})).statusCode, proxy ? 403 : 401);
        const signed = await call(real);
        assert.equal(signed.statusCode,200,signed.body);
        assert.equal(signed.json().user.id,subject);
        const cookie = signed.cookies[0].name+'='+signed.cookies[0].value;
        assert.equal((await incoming({path:'/cameras',headers:{cookie,...real}})).statusCode,200);
        const mismatch = proxy ? {'x-wui-forwarded-subject':'subject-two'} : {'remote-user':'subject-two'};
        assert.equal((await incoming({path:'/cameras',headers:{cookie,...real,...mismatch}})).statusCode,401);
        assert.equal((await call({cookie,...real,...mismatch})).statusCode,409);
        if (proxy) assert.equal((await call({ ...real,'x-wui-forward-proof':'bogus' })).statusCode,403);
      }
      if (oidc) {
        const id = await seed({issuer: new URL(oidc.issuer).href, subject:'stable-subject'});
        const finish = async ({fault} = {}) => {
          const start = await incoming({path:'/session/oidc/start'});
          assert.equal(start.statusCode,303,start.body);
          const params = new URL(start.headers.location).searchParams;
          assert.equal(params.get('code_challenge_method'),'S256');
          assert.equal(params.get('redirect_uri'),publicOrigin+(proxy?'/front':'/api')+'/v1/session/oidc/callback');
          assert.ok(params.get('nonce') && params.get('state'));
          oidc.set(params,fault);
          const {name,value} = start.cookies[0];
          const headers = {cookie:name+'='+value, ...(proxy?{'x-wui-forward-proof':hop}:{})};
          const path = '/session/oidc/callback?code=fixture-code&state='+(fault==='state'?'mismatched':encodeURIComponent(params.get('state')));
          const done = await incoming({path,headers});
          assert.equal((await incoming({path,headers})).statusCode,400);
          return done;
        };
        const done = await finish();
        assert.equal(done.statusCode,303,done.body);
        const authCookie = done.cookies.find(cookie => cookie.name==='__Host-reolink_session');
        const session = (await incoming({path:'/session',headers:{cookie:authCookie.name+'='+authCookie.value}})).json();
        assert.equal(session.user.id,id);
        if (mode==='oidc') for (const fault of ['state','issuer','signature','audience','expired','nonce']) {
          assert.equal((await finish({fault})).statusCode,401,fault);
        }
      }
    });
  }
}
