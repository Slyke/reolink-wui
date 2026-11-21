import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { launch, hop, localPassword, publicOrigin } from './support.mjs';

const secret = 'fixture-ingress-proof-token-long';
const ingress = { issuer:'test-ingress', peers:['127.0.0.1'], secret };
const secretOidc = 'fixture-oidc-verifier-secret-long';

const provider = async ({ withUserInfo = false } = {}) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength:2048 });
  const wrong = generateKeyPairSync('rsa', { modulusLength:2048 }).privateKey;
  const header = Buffer.from(JSON.stringify({alg:'RS256',kid:'test',typ:'JWT'})).toString('base64url');
  let expected, fault, profile = {}, info = {}, infoStatus = 200;
  let infoCalls = 0;
  const server = createServer(async (req,res) => {
    res.setHeader('content-type','application/json');
    if (req.url === '/.well-known/openid-configuration') {
      return res.end(JSON.stringify({
        ...(withUserInfo ? { userinfo_endpoint: issuer+'/userinfo', scopes_supported: ['openid','profile','groups'] } : {}),
        issuer, authorization_endpoint:issuer+'/authorization', token_endpoint:issuer+'/token', jwks_uri:issuer+'/jwks',
        response_types_supported:['code'], grant_types_supported:['authorization_code'], subject_types_supported:['public'],
        id_token_signing_alg_values_supported:['RS256'], code_challenge_methods_supported:['S256'],
        token_endpoint_auth_methods_supported:['client_secret_basic']
      }));
    }
    if (req.url === '/userinfo' && withUserInfo) {
      assert.equal(req.headers.authorization, 'Bearer fixture-not-for-wui');
      infoCalls++;
      res.statusCode = infoStatus;
      return res.end(JSON.stringify({sub:'stable-subject', ...info}));
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
        exp:fault==='expired'?now-300:now+90, nonce:fault==='nonce'?'wrong':expected.get('nonce'), ...profile
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
    issuer, profile: value => {profile=value;}, info: (value,status=200) => {info=value;infoStatus=status;},
    infoCalls: () => infoCalls,
    set:(request,error) => {expected=request;fault=error;},
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

const externalFlow = async (incoming, idp) => {
  const start = await incoming({path:'/session/oidc/start'});
  assert.equal(start.statusCode,303,start.body);
  const params = new URL(start.headers.location).searchParams;
  idp.set(params);
  const flow = start.cookies[0];
  const response = await incoming({path:'/session/oidc/callback?code=fixture-code&state='+encodeURIComponent(params.get('state')),
    headers:{cookie:flow.name+'='+flow.value}});
  return {response, scopes:params.get('scope').split(' ')};
};
const browserCookie = response => {
  const item = response.cookies.find(cookie => cookie.name === '__Host-reolink_session');
  return {cookie:item.name+'='+item.value};
};

for (const database of [undefined, ...(process.env.WUI_TEST_POSTGRES ? [{driver:'postgres',url:process.env.WUI_TEST_POSTGRES,tls:false}] : [])]) {
  test('external account lifecycle, explicit multi-method links and deletion on '+(database?.driver ?? 'sqlite'), async t => {
    const idp = await provider();
    t.after(() => idp.close());
    const auth = {mode:'oidc+proxy-headers+local',ingress,oidc:{issuer:idp.issuer,clientId:'wui',clientSecret:secretOidc}};
    const {app,seed,signIn,incoming,runtime} = await launch({auth,database});
    t.after(() => app.close());
    const adminId = await seed({username:'lifecycle-admin',admin:true});
    const admin = await signIn('lifecycle-admin');
    const adminCall = (method,path,body) => incoming({method,path:'/admin'+path,headers:admin,payload:{operationId:randomUUID(),...body}});
    const trusted = {'remote-user':'lifecycle-header','x-wui-ingress-proof':secret};
    const login = () => incoming({method:'POST',path:'/session/proxy',headers:trusted});
    const attempts = await Promise.all([login(),login(),login()]);
    assert.ok(attempts.every(r => r.statusCode === 200));
    const {id} = attempts[0].json().user;
    assert.ok(attempts.every(r => r.json().user.id===id && !r.json().user.admin));
    const user = {...trusted,...browserCookie(attempts[0]),'x-csrf-token':attempts[0].json().csrf};
    assert.deepEqual((await incoming({path:'/cameras',headers:user})).json().cameras,[]);
    assert.equal((await incoming({path:'/admin',headers:user})).statusCode,403);
    assert.equal((await incoming({method:'DELETE',path:'/admin/accounts/'+adminId,headers:user,payload:{operationId:randomUUID(),confirmation:true}})).statusCode,403);
    assert.equal((await adminCall('DELETE','/accounts/'+adminId,{confirmation:true})).statusCode,403);

    idp.profile({name:'lifecycle-header',sub:'other-subject'});
    const different = await externalFlow(incoming,idp);
    assert.equal(different.response.statusCode,303);
    const other = (await incoming({path:'/session',headers:browserCookie(different.response)})).json().user;
    assert.notEqual(other.id,id);
    assert.equal(other.label,'lifecycle-header');
    const link = identity => adminCall('POST','/accounts/'+id+'/identities',{identity});
    assert.notEqual((await link({subject:'stable-subject'})).json().outcome,'confirmed');
    assert.equal((await link({type:'oauth',subject:'stable-subject'})).json().outcome,'confirmed');
    assert.notEqual((await link({type:'oauth',subject:'other-subject'})).json().outcome,'confirmed');
    assert.equal((await adminCall('PUT','/accounts/'+id+'/local',{username:'lifecycle-local',password:localPassword})).json().outcome,'confirmed');
    const local = await signIn('lifecycle-local');
    idp.profile({});
    const linked = await externalFlow(incoming,idp);
    assert.equal((await incoming({path:'/session',headers:browserCookie(linked.response)})).json().user.id,id);
    const data = () => incoming({path:'/admin',headers:admin}).then(r=>r.json());
    const account = (await data()).accounts.find(a=>a.id===id);
    assert.deepEqual(account.types.sort(),['headers','local','oauth']);

    assert.equal((await adminCall('PATCH','/accounts/'+id,{enabled:false,confirmation:true})).json().outcome,'confirmed');
    assert.equal((await login()).statusCode,403);
    assert.equal((await externalFlow(incoming,idp)).response.statusCode,403);
    assert.equal((await adminCall('PATCH','/accounts/'+id,{enabled:true,confirmation:true})).json().outcome,'confirmed');
    const renewed = await login();
    await runtime.sql.query('INSERT INTO bridges(id) VALUES ($1)','lifecycle-bridge');
    const camera=randomUUID();
    await runtime.sql.query('INSERT INTO cameras(id,bridge_id,remote_id) VALUES ($1,$2,$3)',camera,'lifecycle-bridge','test');
    await runtime.sql.query('INSERT INTO grants(account_id,camera_id,permissions) VALUES ($1,$2,$3)',id,camera,'["view"]');
    assert.equal((await adminCall('DELETE','/accounts/'+id,{confirmation:true})).json().outcome,'confirmed');
    assert.equal((await data()).accounts.some(a=>a.id===id),false);
    assert.equal((await runtime.sql.query('SELECT id FROM accounts WHERE id=$1',id)).length,0);
    assert.equal((await runtime.sql.query('SELECT * FROM grants WHERE account_id=$1',id)).length,0);
    assert.ok((await runtime.sql.query('SELECT id FROM audit WHERE actor=$1',id)).length>0);
    assert.equal((await incoming({path:'/cameras',headers:local})).statusCode,401);
    assert.equal((await incoming({path:'/cameras',headers:{...browserCookie(renewed),...trusted}})).statusCode,401);
    const recreated = await login();
    assert.notEqual(recreated.json().user.id,id);
    assert.deepEqual((await incoming({path:'/cameras',headers:{...browserCookie(recreated),...trusted}})).json().cameras,[]);
  });
}

test('OAuth group arrays gate registration, existing sessions and protected reads',async t=>{
  const idp=await provider({withUserInfo:true});
  t.after(()=>idp.close());
  const {app,seed,signIn,incoming,runtime}=await launch({auth:{mode:'oidc+local',oidc:{issuer:idp.issuer,clientId:'wui',clientSecret:secretOidc}}});
  t.after(()=>app.close());
  await seed({username:'groups-admin',admin:true});
  const admin=await signIn('groups-admin');
  const set=async (requiredGroups,requiredGroupsMode) => incoming({method:'PUT',path:'/admin/oidc-groups',headers:admin,
    payload:{operationId:randomUUID(),requiredGroups,requiredGroupsMode}});
  assert.equal((await set('cameras','any')).statusCode,400);
  assert.equal((await set(['cameras','night shift'],'any')).json().outcome,'confirmed');
  idp.profile({groups:['cameras'],name:'A normal user'});
  idp.info({groups:['Cameras']});
  assert.equal((await externalFlow(incoming,idp)).response.statusCode,403);
  assert.equal((await runtime.sql.query('SELECT * FROM identities')).length,0);
  idp.info({groups:['night shift'],sub:'wrong-subject'});
  assert.notEqual((await externalFlow(incoming,idp)).response.statusCode,303);
  idp.info({groups:['night shift']});
  const allowed=await externalFlow(incoming,idp);
  assert.equal(allowed.response.statusCode,303,allowed.response.body);
  assert.ok(allowed.scopes.includes('groups'));
  const headers=browserCookie(allowed.response);
  assert.deepEqual((await incoming({path:'/cameras',headers})).json().cameras,[]);
  const [session]=await runtime.sql.query("SELECT group_token FROM sessions WHERE method='oidc'");
  assert.ok(session.group_token && !session.group_token.includes('fixture-not-for-wui'));
  const calls=idp.infoCalls();
  await runtime.sql.query("UPDATE sessions SET group_checked=0 WHERE method='oidc'");
  assert.ok((await Promise.all([1,2,3].map(()=>incoming({path:'/cameras',headers})))).every(r=>r.statusCode===200));
  assert.equal(idp.infoCalls(),calls+1);
  idp.info({groups:[]});
  await runtime.sql.query("UPDATE sessions SET group_checked=0 WHERE method='oidc'");
  assert.equal((await incoming({path:'/session',headers})).json().user,undefined);
  assert.equal((await incoming({path:'/cameras',headers})).statusCode,401);
  idp.info({groups:['night shift']});
  const next=await externalFlow(incoming,idp);
  assert.equal((await set(['cameras','night shift'],'all')).json().outcome,'confirmed');
  assert.equal((await incoming({path:'/cameras',headers:browserCookie(next.response)})).statusCode,401);
  assert.equal((await externalFlow(incoming,idp)).response.statusCode,403);
  idp.info({groups:['night shift','cameras']});
  assert.equal((await externalFlow(incoming,idp)).response.statusCode,303);
  assert.equal((await incoming({path:'/admin',headers:admin})).statusCode,200);
});

test('configuration-pinned groups support signed token claims and bound their lifetime',async t=>{
  const idp=await provider();
  t.after(()=>idp.close());
  const {app,seed,signIn,incoming}=await launch({auth:{mode:'oidc+local',oidc:{issuer:idp.issuer,clientId:'wui',clientSecret:secretOidc,
    requiredGroups:['view cameras','team'],requiredGroupsMode:'all',groupScope:''}}});
  t.after(()=>app.close());
  await seed({username:'pinned-admin',admin:true});
  const headers=await signIn('pinned-admin');
  const group=(await incoming({path:'/admin',headers})).json().oidcGroups;
  assert.deepEqual(group,{requiredGroups:['view cameras','team'],requiredGroupsMode:'all',fromConfig:true});
  assert.equal((await incoming({method:'PUT',path:'/admin/oidc-groups',headers,payload:{operationId:randomUUID(),requiredGroups:[],requiredGroupsMode:'any'}})).statusCode,422);
  idp.profile({groups:'view cameras,team'});
  assert.equal((await externalFlow(incoming,idp)).response.statusCode,403);
  idp.profile({groups:['view cameras','team'],exp:Math.floor(Date.now()/1000)+3600});
  const ok=await externalFlow(incoming,idp);
  assert.ok(!ok.scopes.includes('groups'));
  assert.equal(ok.response.statusCode,303,ok.response.body);
  assert.ok(ok.response.cookies.find(c=>c.name==='__Host-reolink_session').maxAge<=300);
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
        const finish = async ({fault,next} = {}) => {
          const start = await incoming({path:'/session/oidc/start'+(next?'?'+new URLSearchParams({next}):'')});
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
        const sharedRecording='/recordings?camera=fixture&date=2026-11-17&recording=clip&stream=main';
        const done = await finish({next:sharedRecording});
        assert.equal(done.statusCode,303,done.body);
        assert.equal(done.headers.location,sharedRecording);
        assert.equal((await finish({next:'https://other.invalid/recordings'})).headers.location,'/');
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
