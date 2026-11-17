import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { launch, fixtureBridge, fixtureBroker, eventually, uuid, publicOrigin, serviceToken } from './support.mjs';
import { configSchema } from '../dist/server/config.js';

const envPg = process.env.WUI_TEST_POSTGRES;
const dbs = [undefined, ...(envPg ? [{ driver:'postgres', url:envPg, tls:false }] : [])];

const expectMediaClosed = async reader => {
  try {
    while (!(await reader.read()).done) { /* Drain frames queued before closing. */ }
  } catch (error) {
    // A revoked viewer's response can close before a final HTTP chunk is sent.
    assert.equal(error.cause?.code,'UND_ERR_SOCKET');
  }
};

for (const database of dbs) test('authorization, operations and live revocation: ' + (database?.driver ?? 'sqlite'), async t => {
  const bridge = await fixtureBridge({ previewCameras:['alpha'] });
  t.after(() => bridge.close());
  const { app, runtime, incoming, seed, signIn } = await launch({ bridges: [{ ...bridge.config, cameraIds: [] }], database });
  t.after(() => { app.server.closeAllConnections(); return app.close(); });
  const userSuffix = uuid().slice(0, 8);
  const owner = await seed({ username:'operator-' + userSuffix, admin:true });
  const viewer = await seed({ username:'observer-' + userSuffix });
  const allowed = await signIn('operator-' + userSuffix);
  const denied = await signIn('observer-' + userSuffix);
  await eventually(() => runtime.bridges.get('lab').state('beta').has('info'));
  const admin = await incoming({ path:'/admin', headers:allowed });
  const camera = admin.json().cameras.find(row => row.label === 'Loading dock').id;
  const other = admin.json().cameras.find(row => row.label === 'Second camera').id;
  const grant = (who, preset) => incoming({
    method:'PUT', path:'/admin/accounts/' + who + '/grants/' + camera,
    headers:allowed, payload:{ operationId:uuid(), preset, allow:[], deny:[] }
  });
  const inventory = (await incoming({ path:'/cameras',headers:allowed })).json();
  assert.equal(inventory.inventory, 'discovered');
  assert.deepEqual(new Set(inventory.cameras.map(item => item.id)), new Set([camera, other]));
  assert.equal((await incoming({ path:'/cameras/'+camera+'/preview?refresh=true', headers:denied })).statusCode, 403);
  const profileUrl = '/cameras/' + other + '/playback';
  const setProfile = fields => incoming({
    path:profileUrl, method:'PUT', headers:allowed, payload:{operationId:uuid(),source:'direct',...fields}
  });
  assert.deepEqual((await incoming({ path:profileUrl,headers:allowed })).json(),
    {source:'direct',previewIntervalMs:5000,refreshOnAlert:'off'});
  assert.equal((await setProfile({previewIntervalMs:49})).statusCode,400);
  assert.equal((await setProfile({refreshOnAlert:'unknown-type'})).statusCode,400);
  assert.equal((await setProfile({previewIntervalMs:50,refreshOnAlert:'person'})).statusCode,200);
  assert.equal((await setProfile({})).json().data.previewIntervalMs,50);
  const configured = (await incoming({path:'/cameras',headers:allowed})).json().cameras.find(item => item.id === other);
  assert.equal(configured.previewIntervalMs,50);
  assert.equal(configured.refreshOnAlert,'person');
  const refresh = await incoming({ path:'/admin/bridges/lab/sync', method:'POST', headers:allowed, payload:{ operationId:uuid() } });
  assert.match(refresh.json().data.refreshedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.equal((await incoming({path:'/admin',headers:allowed})).json().bridges[0].refreshedAt, refresh.json().data.refreshedAt);
  const readAppearance = () => incoming({path:'/appearance-defaults'});
  const setAppearance = (appearance, headers = allowed) => incoming({
    path:'/admin/appearance-defaults',method:'PUT',headers,payload:{operationId:uuid(),appearance}
  });
  const baseline = {palette:'d4rk',theme:'dark',font:'system-stack',contentWidth:'standard'};
  assert.deepEqual((await readAppearance()).json(), {appearance:baseline});
  assert.equal((await setAppearance(baseline,denied)).statusCode,403);
  assert.equal((await setAppearance({...baseline,theme:'unknown'})).statusCode,400);
  const custom = {...baseline,palette:'ocean',theme:'light'};
  assert.equal((await setAppearance(custom)).statusCode,200);
  assert.deepEqual((await readAppearance()).json(), {appearance:custom});

  assert.equal((await incoming({ path:'/status' })).statusCode, 401);
  assert.deepEqual((await incoming({ path:'/status',headers:denied })).json(), { upstreams: [] });
  const status = await incoming({ path:'/status',headers:allowed });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json().upstreams, [{
    id:'lab', label:'Fixture bridge', connections:[
      { id:'http', transport:'HTTP', uses:['api','commands','callbacks'], state:'online' },
      { id:'mqtt', transport:'MQTT', uses:['events'], state:'online' }
    ]
  }]);
  assert.equal((await grant(owner, 'none')).json().reason, 'ACCESS_DENIED');
  assert.equal((await incoming({ path:'/cameras/' + camera + '/capabilities',headers:allowed })).json().ptz.write, true);
  assert.equal((await grant(viewer, 'viewer')).statusCode, 200);
  assert.deepEqual((await incoming({ path:'/status',headers:denied })).json(), status.json());
  assert.equal((await incoming({ path:'/cameras/' + other,headers:allowed })).statusCode, 200);
  assert.equal((await incoming({ path:'/cameras/' + other,headers:denied })).statusCode, 403);
  const detail = (await incoming({ path:'/cameras/' + camera,headers:allowed })).body;
  assert.ok(!detail.includes(serviceToken));
  const viewerCaps = (await incoming({ path:'/cameras/' + camera + '/capabilities',headers:denied })).json();
  assert.equal(viewerCaps.ptz, undefined);
  assert.equal(viewerCaps.capture, false);

  const id = uuid();
  const led = { path:'/cameras/' + camera + '/settings/leds', method:'PATCH', payload:{ operationId:id, change:{setting:'status_led',enabled:true} } };
  assert.equal((await incoming({ ...led, headers:denied })).statusCode, 403);
  assert.equal((await incoming({ ...led, headers:{...allowed,origin:'https://wrong.invalid'} })).statusCode, 403);
  assert.equal((await incoming({ ...led, headers:{cookie:allowed.cookie} })).statusCode, 403);
  const control = await incoming({ ...led, headers:allowed });
  assert.equal(control.statusCode, 200, control.body);
  assert.equal(control.json().outcome, 'confirmed');
  assert.ok(control.json().bridgeCorrelationId);
  assert.equal(bridge.correlations[0], control.headers['x-correlation-id']);
  assert.equal(control.json().data.leds.status_led, true);
  assert.ok(!control.body.includes(serviceToken));
  assert.equal((await incoming({ ...led, headers:allowed })).statusCode, 200);
  assert.equal(bridge.counts().writes, 1);
  assert.equal((await incoming({ path:'/operations/' + id, headers:denied })).statusCode, 404);
  assert.equal((await incoming({ ...led, headers:allowed, payload:{ operationId:id,change:{setting:'status_led',enabled:false} } })).statusCode, 409);
  assert.equal((await incoming({ ...led, headers:allowed, payload:{ operationId:uuid(), change:{setting:'ExecuteVendorCommand', command:'anything'} } })).statusCode, 400);

  const moveId = uuid();
  const ptz = (payload) => incoming({ path:'/cameras/' + camera + '/ptz', method:'POST', headers:allowed, payload });
  const stopped = await ptz({ operationId:uuid(), action:{op:'stop'}, interrupts:moveId });
  assert.equal(stopped.json().data.stopped,true);
  const cancelled = await ptz({ operationId:moveId, action:{op:'move', direction:'left', duration_ms:300} });
  assert.equal(cancelled.json().reason,'PTZ_CANCELLED');
  assert.equal(bridge.counts().writes,1);
  assert.equal((await ptz({ operationId:uuid(), action:{op:'move', direction:'left', duration_ms:4000} })).statusCode,400);

  const alerts = await incoming({ path:'/cameras/' + camera + '/alerts?fresh=true', headers:allowed });
  assert.equal(alerts.statusCode, 200, alerts.body);
  assert.ok(!alerts.body.includes(serviceToken));
  const update = await incoming({ path:'/cameras/' + camera + '/alerts/motion', headers:allowed, method:'PATCH',
    payload:{ operationId:uuid(), change:{setting:'motion_detection',enabled:false} } });
  assert.equal(update.json().data.motion_detection.enabled, false);
  assert.equal((await incoming({ path:'/cameras/' + camera + '/alerts?fresh=true',headers:allowed })).json().values.motion_detection.enabled,false);

  const add = await incoming({ path:'/admin/bridges/lab/callbacks',headers:allowed,method:'POST',
    payload:{ operationId:uuid(), action:'add', id:'automation', destination:'fixture', events:['motion'], cameras:[camera] } });
  assert.equal(add.statusCode,200,add.body);
  assert.deepEqual(add.json().data[0].cameras,[camera]);
  assert.ok(!add.body.includes('/callback'));
  assert.equal((await incoming({ path:'/admin/bridges/lab/callbacks', headers:denied })).statusCode,403);

  const origin = await app.listen({ host:'127.0.0.1',port:0 });
  const open = new AbortController();
  t.after(() => open.abort());
  const eventStream = await fetch(origin + '/api/v1/events', { headers:denied, signal:open.signal });
  assert.equal(eventStream.status,200);
  const eventReader = eventStream.body.getReader();
  await eventReader.read();
  bridge.event('beta','privateEvent');
  bridge.event('alpha','motion');
  const {value} = await eventReader.read();
  const delivered = Buffer.from(value).toString();
  assert.match(delivered,/motion/);
  assert.doesNotMatch(delivered,/privateEvent/);
  assert.ok(!delivered.includes(serviceToken));

  const preview = await incoming({ path:'/cameras/' + camera + '/preview', headers:denied });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.headers['content-type'], 'image/jpeg');
  assert.equal(preview.rawPayload.readUInt16BE(0), 0xffd8);
  const lease = async headers => {
    const response = await incoming({ path:'/cameras/' + camera + '/media-sessions', method:'POST', headers,
      payload:{ operationId:uuid(),stream:'main' } });
    assert.equal(response.statusCode,200,response.body);
    return response.json().data.url;
  };
  const mediaUrl = await lease(denied);
  assert.equal((await incoming({ path:mediaUrl.slice('/api/v1'.length),headers:allowed })).statusCode,403);
  const secondUrl = await lease(allowed);
  const readMedia = async (path, headers) => {
    const response = await fetch(origin+path,{
      headers, signal:AbortSignal.any([open.signal,AbortSignal.timeout(8000)])
    });
    assert.equal(response.status,200);
    return response.body.getReader();
  };
  const [reader, second] = await Promise.all([readMedia(mediaUrl,denied),readMedia(secondUrl,allowed)]);
  for (const input of [reader,second]) {
    assert.match(Buffer.from((await input.read()).value).toString(),/^--wui\r\nContent-Type: image\/jpeg/);
  }
  const laterUrl = await lease(allowed);
  const later = await readMedia(laterUrl,allowed);
  assert.match(Buffer.from((await later.read()).value).toString(),/^--wui\r\nContent-Type: image\/jpeg/);
  await later.cancel();
  assert.equal(bridge.counts().mediaOpened,1);
  assert.equal((await grant(viewer,'none')).statusCode,200);
  assert.deepEqual((await incoming({ path:'/status', headers:denied })).json(), { upstreams: [] });
  await expectMediaClosed(reader);
  assert.equal((await second.read()).done,false);
  assert.equal(bridge.counts().mediaClosed,0);
  assert.equal((await incoming({path:secondUrl.slice('/api/v1'.length),method:'DELETE',headers:allowed})).statusCode,204);
  await eventually(() => bridge.counts().mediaOpened === 1 && bridge.counts().mediaClosed === 1);
  assert.match(Buffer.from((await eventReader.read()).value).toString(), /access-changed/);
  assert.equal((await eventReader.read()).done,true);
  assert.equal((await incoming({ path:'/cameras/' + camera, headers:denied })).statusCode,403);
  open.abort();
  assert.equal((await incoming({ method:'DELETE', path:'/session',headers:allowed })).statusCode,204);
  assert.equal((await incoming({ path:'/admin',headers:allowed })).statusCode,401);
});

test('default WebSocket preference keeps MQTT warm and deduplicates events during failover', async t => {
  const fixture = await fixtureBridge({ websocket:true });
  t.after(() => fixture.close());
  const { app, runtime } = await launch({ bridges:[{...fixture.config, events:undefined}] });
  t.after(() => app.close());
  const bridge = runtime.bridges.get('lab');
  const role = id => bridge.upstream().connections.find(connection => connection.id === id)?.feed;
  const delivered = [];
  const gaps = [];
  const stop = bridge.observe(update => {
    if (update.kind === 'event') delivered.push(update.topic);
    if (update.kind === 'gap') gaps.push(update.details);
  });
  t.after(stop);

  await eventually(() => role('ws') === 'active' && role('mqtt') === 'standby');
  const initial = fixture.event('alpha','person');
  await eventually(() => delivered.length === 1);
  fixture.detection('alpha','person',true);
  fixture.disconnectWs();
  await eventually(() => role('mqtt') === 'active' && bridge.state('alpha').get('state/person')?.active);
  fixture.publishEvent(initial,'mqtt');
  fixture.event('alpha','pet',{},'mqtt');
  await eventually(() => delivered.includes('pet'));
  assert.deepEqual(delivered,['person','pet']);
  assert.deepEqual(gaps,[]);
  fixture.reconnectWs();
  await eventually(() => role('ws') === 'active' && role('mqtt') === 'standby');
  fixture.event('alpha','motion',{},'ws');
  await eventually(() => delivered.includes('motion'));
  assert.deepEqual(delivered,['person','pet','motion']);
  assert.deepEqual(gaps,[]);
});

test('explicit MQTT preference uses WebSocket while the broker is down', async t => {
  const fixture = await fixtureBridge({ websocket:true });
  t.after(() => fixture.close());
  const { app, runtime } = await launch({ bridges:[{...fixture.config, events:{primary:'mqtt',secondary:'ws'}}] });
  t.after(() => app.close());
  const bridge = runtime.bridges.get('lab');
  const role = id => bridge.upstream().connections.find(connection => connection.id === id)?.feed;
  await eventually(() => role('mqtt') === 'active' && role('ws') === 'standby');
  await fixture.disconnect();
  await eventually(() => role('ws') === 'active');
  assert.equal(bridge.feedReady,true);
  assert.equal(bridge.feedGap,undefined);
  await fixture.reconnect();
  await eventually(() => role('mqtt') === 'active' && role('ws') === 'standby');
});

test('HTTP reply loss reports unknown while the MQTT feed reconnects', async t => {
  const bridge = await fixtureBridge();
  t.after(() => bridge.close());
  const { app, runtime, incoming, seed, signIn } = await launch({ bridges:[bridge.config] });
  t.after(() => app.close());
  await seed({username:'operator',admin:true});
  const headers = await signIn('operator');
  await eventually(() => runtime.bridges.get('lab').feedReady);
  const camera = (await incoming({ path:'/admin',headers })).json().cameras[0].id;
  const send = id => incoming({ method:'PATCH',path:'/cameras/'+camera+'/settings/leds',headers,
    payload:{operationId:id,change:{setting:'status_led',enabled:true}} });
  const op = uuid();
  bridge.lose();
  const unknown = await send(op);
  assert.equal(unknown.statusCode,504,unknown.body);
  assert.equal(unknown.json().outcome,'unknown');
  assert.equal((await app.inject('/livez')).statusCode,200);
  const unhealthy = await app.inject('/readyz');
  assert.equal(unhealthy.statusCode,500);
  assert.deepEqual(Object.keys(unhealthy.json()).sort(), ['buildDate','buildHash','correlationId','ok','service','version']);
  const interruption = await eventually(() => runtime.bridges.get('lab').feedGap);
  assert.equal(interruption?.cause,'bridge-connection');
  assert.equal(interruption.transport,'MQTT');
  assert.equal(interruption.failure,'transport');
  assert.equal(interruption.recoveredAt,undefined);
  await bridge.reconnect();
  await eventually(() => {
    const upstream = runtime.bridges.get('lab');
    return upstream.feedReady && upstream.state('alpha').get('availability')?.online;
  });
  assert.equal(runtime.bridges.get('lab').feedGap,undefined);
  assert.equal((await send(op)).json().outcome,'unknown');
  assert.equal((await send(uuid())).json().errorKey,'RECONCILE_REQUIRED');
  assert.equal(bridge.counts().writes,1);
  assert.equal((await app.inject('/livez')).statusCode,200);
});

test('live delivery reports count only skipped alerts visible to the subscriber', async t => {
  const bridge = await fixtureBridge();
  t.after(() => bridge.close());
  const { app, runtime, incoming, seed, signIn, base } = await launch({
    bridges:[bridge.config], eventHistory:{ backend:'memory', retention:400 }
  });
  const connection = new AbortController();
  t.after(() => { connection.abort(); app.server.closeAllConnections(); return app.close(); });
  const viewer = await seed({ username:'gap-viewer' });
  const headers = await signIn('gap-viewer');
  await eventually(() => runtime.bridges.get('lab').feedReady);
  const [camera] = await runtime.sql.query('SELECT id FROM cameras WHERE remote_id=$1','alpha');
  await runtime.sql.query('INSERT INTO grants VALUES ($1,$2,$3)',viewer,camera.id,JSON.stringify(['view','events']));
  const origin = await app.listen({host:'127.0.0.1',port:0});
  const response = await fetch(origin+base+'/events',{
    headers, signal:AbortSignal.any([connection.signal,AbortSignal.timeout(8000)])
  });
  assert.equal(response.status,200);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  const next = async () => {
    let end;
    while ((end = pending.indexOf('\n\n')) === -1) {
      const { value, done } = await reader.read();
      assert.ok(!done);
      pending += value;
    }
    const frame = JSON.parse(pending.slice(6,end));
    pending = pending.slice(end+2);
    return frame;
  };
  assert.equal((await next()).kind,'connected');
  for (let index = 0; index < 132; index++) bridge.event('beta','privateEvent');
  bridge.event('alpha','motion');
  const visible = await next();
  assert.equal(visible.kind,'event');
  assert.equal(visible.event.type,'motion');

  for (let index = 0; index < 132; index++) bridge.event('alpha','person');
  const report = await next();
  assert.equal(report.kind,'gap');
  assert.equal(report.details.cause,'delivery-backlog');
  assert.equal(report.details.droppedEvents,128);
  assert.ok(report.details.firstObservedAt <= report.details.lastObservedAt);
  assert.equal(report.details.samples.length,8);
  assert.ok(report.details.samples.every(item => item.camera === camera.id && item.type === 'person'));
  assert.doesNotMatch(JSON.stringify(report),/privateEvent/);
  const history = await incoming({ path:'/cameras/'+camera.id+'/events',headers });
  assert.equal(history.statusCode,200);
  assert.equal(history.json().events.filter(item => item.event.type === 'person').length,132);
});

test('invalid combined authentication and database declarations are rejected', () => {
  const base = { publicOrigin, auth:{mode:'local'}, database:{driver:'sqlite',path:':memory:'} };
  assert.equal(configSchema.safeParse(base).success,true);
  assert.equal(configSchema.safeParse({...base, auth:{mode:'oidc+proxy-headers'}}).success,false);
  assert.equal(configSchema.safeParse({...base, database:{...base.database,url:'postgres://localhost/db'}}).success,false);
  assert.equal(configSchema.safeParse({...base,httpApi:{mode:'browser',browserBasePath:'/../'}}).success,false);
  assert.equal(configSchema.safeParse({...base,httpApi:{mode:'proxy'}}).success,false);
});

const pngChunk = (name, data) => {
  const chunk = Buffer.alloc(12+data.length);
  chunk.writeUInt32BE(data.length);
  chunk.write(name,4);
  data.copy(chunk,8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4,-4)),chunk.length-4);
  return chunk;
};
const png = () => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1,0); header.writeUInt32BE(1,4); header[8]=8; header[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(Buffer.from([0,3,8,30]))),pngChunk('IEND',Buffer.alloc(0))]);
};

test('MQTT 5 capture uses exact topics and validates PNG; broker runs only on loopback', async t => {
  const { client, url: server, close } = await fixtureBroker();
  t.after(close);
  const root = 'fixture/cam';
  const bytes = png();
  let captures = 0;
  let valid = true;
  await client.subscribeAsync(root+'/command/exec');
  client.on('message',(topic,payload,packet) => {
    assert.equal(topic,root+'/command/exec');
    assert.equal(packet.retain,false);
    const { id, command } = JSON.parse(payload);
    if (command.setting === 'snapshot') captures++;
    const result = { content_type:'image/png',encoding:'base64',width:valid ? 1 : 1921,height:1,data_base64:bytes.toString('base64') };
    void client.publishAsync(root+'/command/result',JSON.stringify({ id:uuid(),ok:true,result }));
    void client.publishAsync(root+'/command/result',JSON.stringify({ id,ok:true,result,correlation_id:uuid() }));
  });
  await client.publishAsync(root+'/availability',JSON.stringify({online:true}),{retain:true});
  await client.publishAsync(root+'/capabilities',JSON.stringify({baichuan:{controls:{}}}),{retain:true});
  const bridge = await fixtureBridge();
  t.after(() => bridge.close());
  const { app,runtime,incoming,seed,signIn } = await launch({ bridges:[{
    id:'mqtt',label:'Local MQTT',commands:'mqtt',events:'mqtt',capture:'mqtt',mqtt:{url:server,baseTopic:'fixture',cameraIds:['cam']}
  }, bridge.config] });
  t.after(() => app.close());
  await seed({username:'operator',admin:true});
  const headers = await signIn('operator');
  const camera = (await incoming({path:'/admin',headers})).json().cameras.find(item => item.bridge === 'mqtt').id;
  await eventually(() => runtime.bridges.get('mqtt').feedReady && runtime.bridges.get('mqtt').state('cam').has('capabilities'));
  const connections = await eventually(async () => {
    const { upstreams } = (await incoming({ path:'/status',headers })).json();
    const rows = upstreams.flatMap(upstream => upstream.connections.filter(connection => connection.transport === 'MQTT'));
    return rows.length === 2 && rows.every(row => row.state === 'online') && rows;
  });
  assert.deepEqual(connections.map(row => row.uses), [['events','commands','capture'], ['events']]);
  const read = () => incoming({path:'/cameras/'+camera+'/snapshots',method:'POST',headers,payload:{operationId:uuid()}});
  const snapshot = await read();
  assert.equal(snapshot.statusCode,200,snapshot.body);
  assert.deepEqual(snapshot.rawPayload,bytes);
  assert.match(snapshot.headers['cache-control'],/no-store/);
  valid = false;
  assert.equal((await read()).json().reason,'SNAPSHOT_INVALID');
  valid = true;
  assert.equal((await incoming({ path:'/cameras/'+camera+'/preview',headers })).statusCode,422);
  assert.equal((await incoming({ path:'/cameras/'+camera+'/preview?refresh=true',headers })).statusCode,422);
  assert.equal(captures,2);
  assert.equal((await read()).statusCode,200);
  assert.equal(captures,3);
});

test('bridge cached preview forwards conditional JPEG reads with camera authorization', async t => {
  const bridge = await fixtureBridge({ previewCameras:['alpha'] });
  t.after(() => bridge.close());
  const { app, runtime, seed, signIn, incoming } = await launch({ bridges:[bridge.config], proxy:true });
  t.after(() => app.close());
  await seed({username:'preview-admin',admin:true});
  await seed({username:'preview-denied'});
  const headers = await signIn('preview-admin');
  const viewer = await signIn('preview-denied');
  await eventually(() => runtime.bridges.get('lab').hasPreview('alpha'));
  const { cameras } = (await incoming({ path:'/cameras',headers })).json();
  const camera = cameras.find(item => item.name === 'Loading dock');
  assert.equal(camera.capabilities.bridgePreview,true);
  const path = '/cameras/' + camera.id + '/preview';
  const changedSource = await incoming({
    path:'/cameras/' + camera.id + '/playback', method:'PUT', headers,
    payload:{ operationId:uuid(),source:'proxy',proxyUrl:'rtsp://127.0.0.1:8554/fixture' }
  });
  assert.equal(changedSource.statusCode,200);
  assert.equal((await incoming({ path,headers:viewer })).statusCode,403);
  assert.equal(bridge.previewRequests.length,0);
  const initial = await incoming({ path,headers });
  assert.equal(initial.statusCode,200,initial.body);
  assert.match(initial.headers.etag,/^"[0-9a-f]{64}"$/);
  assert.equal(initial.headers['x-preview-captured-at'],'2026-11-16T12:00:00.123Z');

  const conditional = { ...headers, 'if-none-match':initial.headers.etag };
  const unchanged = await incoming({ path,headers:conditional });
  assert.equal(unchanged.statusCode,304);
  assert.equal(unchanged.rawPayload.length,0);
  assert.equal(unchanged.headers.etag,initial.headers.etag);
  assert.equal(bridge.previewRequests.at(-1).unchanged,true);
  bridge.changePreview();
  const changed = await incoming({ path,headers:conditional });
  assert.equal(changed.statusCode,200);
  assert.notEqual(changed.headers.etag,initial.headers.etag);
  assert.notDeepEqual(changed.rawPayload,initial.rawPayload);
  assert.equal((await incoming({ path:path+'?refresh=true',headers })).statusCode,200);
  assert.equal(bridge.previewRequests.at(-1).refresh,true);
  assert.equal(bridge.counts().mediaOpened,0);
});

const historyBackends = [{ backend:'memory', retention:3 }];
if (process.env.WUI_TEST_VALKEY) {
  historyBackends.push({ backend:'valkey', retention:3, url:process.env.WUI_TEST_VALKEY, keyPrefix:'wui-test-'+uuid() });
}
for (const eventHistory of historyBackends) test('camera history limits, restart and authorization: '+eventHistory.backend, async t => {
  const bridge = await fixtureBridge();
  t.after(() => bridge.close());
  const directory = await mkdtemp(join(tmpdir(),'wui-events-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const database = { driver:'sqlite', path:join(directory,'wui.sqlite') };
  const config = { eventHistory, database, bridges:[bridge.config] };
  const first = await launch(config);
  let closed = false;
  t.after(() => closed ? undefined : first.app.close());
  await first.seed({username:'timeline-admin',admin:true});
  await first.seed({username:'timeline-user'});
  const headers = await first.signIn('timeline-admin');
  const ungranted = await first.signIn('timeline-user');
  await eventually(() => first.runtime.bridges.get('lab').feedReady);
  const cameras = (await first.incoming({path:'/admin',headers})).json().cameras;
  const alpha = cameras.find(item => item.label === 'Loading dock').id;
  const beta = cameras.find(item => item.label === 'Second camera').id;
  const historyPath = id => '/cameras/'+id+'/events';
  const settings = '/admin/event-history';
  assert.equal((await first.incoming({path:historyPath(alpha),headers:ungranted})).statusCode,403);
  assert.equal((await first.incoming({path:settings,headers:ungranted})).statusCode,403);
  await eventually(async () => (await first.incoming({ path:settings, headers })).statusCode === 200);
  const read = (app, camera, credentials = headers) => app.incoming({path:historyPath(camera),headers:credentials});
  const limit = (app, n, credentials = headers) => app.incoming({
    path:settings, method:'PUT', headers:credentials, payload:{operationId:uuid(),limit:n}
  });
  for (const type of ['one','two','three','four']) bridge.event('alpha',type);
  bridge.event('beta','other');
  const recorded = await eventually(async () => {
    const response = await read(first,alpha);
    return response.statusCode === 200 && response.json().events.at(-1)?.event.type === 'four' && response;
  });
  assert.ok(!recorded.body.includes(serviceToken));
  assert.deepEqual(recorded.json().events.map(item => item.event.type), ['two','three','four']);
  await eventually(async () => (await read(first,beta)).json().events.length === 1);
  assert.equal((await limit(first,2)).statusCode, 200);
  assert.deepEqual((await read(first,alpha)).json().events.map(item => item.event.type), ['three','four']);
  assert.equal((await read(first,beta)).json().events.length,1);

  await first.app.close();
  closed = true;
  const next = await launch(config);
  t.after(() => next.app.close());
  const nextHeaders = await next.signIn('timeline-admin');
  await eventually(async () => (await next.incoming({ path:settings, headers:nextHeaders })).statusCode === 200);
  assert.deepEqual((await next.incoming({path:settings,headers:nextHeaders})).json(), {backend:eventHistory.backend,limit:2});
  assert.equal((await read(next,alpha,nextHeaders)).json().events.length, eventHistory.backend === 'valkey' ? 2 : 0);
  assert.equal((await limit(next,0,nextHeaders)).statusCode,200);
  assert.deepEqual((await read(next,alpha,nextHeaders)).json(), {limit:0,events:[]});
  assert.equal((await limit(next,3,nextHeaders)).statusCode,200);
  assert.deepEqual((await read(next,alpha,nextHeaders)).json(), {limit:3,events:[]});
});

if (process.env.WUI_TEST_RTSP) test('RTSP override streams video and leaves preview reads on the bridge', async t => {
  const bridge = await fixtureBridge({ previewCameras:['alpha'] });
  t.after(() => bridge.close());
  const { app, incoming, seed, signIn } = await launch({bridges:[bridge.config]});
  t.after(() => app.close());
  await seed({username:'playback-admin',admin:true});
  const headers = await signIn('playback-admin');
  const camera = (await incoming({path:'/admin',headers})).json().cameras.find(item => item.label === 'Loading dock').id;
  const prefix = '/cameras/'+camera;
  const set = source => incoming({
    path:prefix+'/playback', method:'PUT', headers, payload:{ operationId:uuid(), ...source }
  });
  const proxyUrl = process.env.WUI_TEST_RTSP;
  assert.equal((await set({source:'proxy',proxyUrl:'file:///etc/passwd'})).statusCode,400);
  assert.equal((await set({source:'proxy',proxyUrl})).statusCode,200);
  const state = await incoming({path:prefix+'/playback',headers});
  assert.deepEqual(state.json(),{source:'proxy',proxyUrl,previewIntervalMs:5000,refreshOnAlert:'off'});
  const preview = await incoming({path:prefix+'/preview',headers});
  assert.equal(preview.statusCode,200,preview.body);
  assert.equal(preview.headers['content-type'],'image/jpeg');
  assert.equal(preview.rawPayload.readUInt16BE(0),0xffd8);
  assert.equal(preview.rawPayload.readUInt16BE(preview.rawPayload.length-2),0xffd9);
  assert.equal(bridge.previewRequests.length,1);
  const session = await incoming({
    path:prefix+'/media-sessions', method:'POST', headers, payload:{operationId:uuid(),stream:'main'}
  });
  assert.equal(session.statusCode, 200, session.body);
  const origin = await app.listen({host:'127.0.0.1',port:0});
  const connection = new AbortController();
  t.after(() => connection.abort());
  try {
    const response = await fetch(origin+session.json().data.url,{
      headers,signal:AbortSignal.any([connection.signal,AbortSignal.timeout(10_000)])
    });
    assert.equal(response.status,200);
    const media = response.body.getReader();
    const jpegStart = Buffer.from([0xff,0xd8]);
    let part = Buffer.alloc(0);
    while (!part.includes(jpegStart) && part.length < 65_536) {
      const chunk = await media.read();
      if (chunk.done) break;
      part = Buffer.concat([part, chunk.value]);
    }
    assert.match(part.toString('latin1'), /Content-type: image\/jpeg/i);
    assert.ok(part.includes(jpegStart));
    assert.equal((await set({source:'direct'})).statusCode,200);
    await expectMediaClosed(media);
  } finally {
    connection.abort();
  }
});

test('inventory interval controls scheduled discovery independently of readiness checks', async t => {
  const bridge=await fixtureBridge();
  t.after(() => bridge.close());
  await bridge.reportInventory(['alpha','beta']);
  const {app, runtime, incoming, seed, signIn} = await launch({bridges:[{...bridge.config,cameraIds:[]}]});
  t.after(() => app.close());
  await seed({username:'inventory-admin',admin:true});
  const headers=await signIn('inventory-admin');
  await eventually(() => bridge.counts().inventoryReads === 1 && runtime.bridges.get('lab').ids().includes('beta'));
  const initial=(await incoming({path:'/admin',headers})).json();
  assert.equal(initial.cameras.length,2);
  assert.equal(initial.bridges[0].refreshedAt,null);
  assert.equal(initial.inventoryIntervalSeconds,10);
  const change = intervalSeconds => incoming({
    method:'PUT',path:'/admin/inventory-settings',headers,payload:{operationId:uuid(),intervalSeconds}
  });
  assert.equal((await change(0)).statusCode,400);
  assert.equal((await change(86401)).statusCode,400);
  assert.equal((await change(86400)).statusCode,200);
  await bridge.reportInventory(['alpha','beta','new-camera']);
  await eventually(async () => (await app.inject('/readyz')).statusCode === 200);
  assert.equal(bridge.counts().inventoryReads,1);
  assert.ok(!(await incoming({path:'/admin',headers})).json().cameras.some(camera => camera.label === 'new-camera'));
  assert.equal((await change(1)).statusCode,200);
  await eventually(async () => {
    const camera=await runtime.sql.query('SELECT id FROM cameras WHERE remote_id=$1','new-camera');
    return camera.length===1 && runtime.bridges.get('lab').state('new-camera').get('availability')?.online === true;
  });
  const updated=(await incoming({path:'/admin',headers})).json();
  assert.ok(updated.cameras.some(camera => camera.label === 'new-camera'));
  assert.equal(updated.bridges[0].refreshedAt,null);
  assert.equal(updated.inventoryIntervalSeconds,1);
});
