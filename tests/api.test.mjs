import { spawnSync } from 'node:child_process';
import { nearestUndatedPhoto } from '../dist/server/nearest-photo.js';
import { timelineIndex } from '../dist/shared/recording-timeline.js';
import { recordingTime, recordingGaps } from '../dist/shared/recording-groups.js';
import { test } from 'node:test';
import { createServer as tcp } from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { png, launch, fixtureBridge, fixtureBroker, eventually, uuid, publicOrigin, serviceToken } from './support.mjs';
import { configSchema } from '../dist/server/config.js';
import { RecordingPreviewCache } from '../dist/shared/recording-preview-cache.js';

const envPg = process.env.WUI_TEST_POSTGRES;
const dbs = [undefined, ...(envPg ? [{ driver:'postgres', url:envPg, tls:false }] : [])];

test('the timeline picks the covering video or nearest saved capture in camera time', () => {
  const stamp = minute => '2026-11-17T12:'+String(minute).padStart(2,'0')+':00';
  const at = minute => recordingTime(stamp(minute));
  const clip = (id,start,end) => ({id,start:stamp(start),end:stamp(end)});
  const video = clip('long',1,9), nested = clip('nested',3,4), later = clip('late',25,27);
  const a = {id:'still-a',capturedAt:stamp(2)}, b = {id:'still-b',capturedAt:stamp(15)};
  const mixed = timelineIndex([later,video,nested],[b,a]);
  assert.equal(mixed.closest(at(2)).item,video);
  assert.equal(mixed.closest(at(3)).item,nested);
  assert.equal(mixed.closest(at(6)).item,video);
  assert.equal(mixed.closest(at(10)).time,at(9)-1000);
  assert.equal(mixed.closest(at(14)).photo,b);
  assert.equal(mixed.closest(at(24)).item,later);
  const only = timelineIndex([],[b,a]);
  assert.equal(only.closest(at(0)).photo,a);
  assert.equal(only.closest(at(59)).photo,b);
  assert.equal(timelineIndex([],[]).closest(at(0)),undefined);
});

test('undated photos need an independently verifiable capture second', async () => {
  assert.equal(await nearestUndatedPhoto(10,100,async () => ['same-reply-for-every-window']),null);
  const read = async (a,b) => [0,60,86_399].filter(t => a<=t && t<=b).map(String);
  assert.deepEqual(await nearestUndatedPhoto(0,0,read),{id:'0',time:0});
  assert.deepEqual(await nearestUndatedPhoto(30,40,read),{id:'0',time:0});
  assert.deepEqual(await nearestUndatedPhoto(86_398,4,read),{id:'86399',time:86_399});
});

test('timeline frames expire after 600 seconds and fallback images belong to the selected clip', t => {
  t.mock.timers.enable({apis:['Date','setTimeout']});
  const cache = new RecordingPreviewCache();
  const frame = {jpeg:Buffer.from('frame'),offsetMs:1000};
  cache.store('first',2000,frame,frame.jpeg.length);
  assert.equal(cache.nearest('second',1000),undefined);
  t.mock.timers.tick(599_999);
  assert.equal(cache.exact('first',2000),frame);
  assert.equal(cache.nearest('first',2500),frame);
  t.mock.timers.tick(1);
  assert.equal(cache.nearest('first',2500),undefined);
  assert.equal(cache.exact('first',2000),undefined);
  cache.clear();
});

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
    {source:'direct',previewIntervalMs:2000,refreshOnAlert:'off'});
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
  let ending = '';
  for (;;) {
    const { done, value } = await second.read();
    if (done) break;
    ending = (ending + Buffer.from(value).toString('latin1')).slice(-16);
  }
  assert.ok(ending.endsWith('--wui--\r\n'));
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

test('admin event-source arrays apply live, fail over across all feeds and survive restart', async t => {
  const fixture=await fixtureBridge({websocket:true,apiEvents:true});
  t.after(()=>fixture.close());
  const directory=await mkdtemp(join(tmpdir(),'wui-source-priority-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const database={driver:'sqlite',path:join(directory,'app.sqlite')};
  const first=await launch({bridges:[{...fixture.config,events:undefined}],database});
  t.after(()=>first.app.close());
  await first.seed({username:'priority-admin',admin:true});
  await first.seed({username:'priority-viewer'});
  const headers=await first.signIn('priority-admin');
  const restricted=await first.signIn('priority-viewer');
  const bridge=first.runtime.bridges.get('lab');
  const role=id=>bridge.upstream().connections.find(connection=>connection.id===id)?.feed;
  await eventually(()=>role('ws')==='active'&&role('mqtt')==='standby'&&role('api')==='standby');
  assert.deepEqual(bridge.eventSources,['ws','mqtt','api']);
  const save=(sources,auth=headers)=>first.incoming({
    method:'PUT',path:'/admin/bridges/lab/event-sources',headers:auth,
    payload:{operationId:uuid(),sources}
  });
  for(const sources of [[],['api','api'],['http'],['api','mqtt','ws','api']]) {
    assert.equal((await save(sources)).statusCode,400);
  }
  assert.equal((await save(['api'],restricted)).statusCode,403);
  assert.equal((await save(['api','ws','mqtt'])).statusCode,200);
  await eventually(()=>role('api')==='active'&&role('ws')==='standby');
  const delivered=[];
  const gaps=[];
  const stop=bridge.observe(update=>{
    if(update.kind==='event') delivered.push(update.topic);
    if(update.kind==='gap') gaps.push(update.details);
  });
  t.after(stop);
  const initial=fixture.event('alpha','person',{},'api');
  await eventually(()=>delivered.length===1);
  fixture.disconnectApi();
  await eventually(()=>role('ws')==='active');
  fixture.publishEvent(initial,'ws');
  fixture.event('alpha','pet',{},'ws');
  await eventually(()=>delivered.includes('pet'));
  fixture.disconnectWs();
  await eventually(()=>role('mqtt')==='active');
  fixture.event('alpha','vehicle',{},'mqtt');
  await eventually(()=>delivered.includes('vehicle'));
  assert.deepEqual(delivered,['person','pet','vehicle']);
  assert.deepEqual(gaps,[]);
  fixture.reconnectApi();
  await eventually(()=>role('api')==='active');
  assert.equal((await save(['api'])).statusCode,200);
  fixture.disconnectApi();
  await eventually(()=>bridge.feedGap?.transport==='HTTP');
  fixture.reconnectApi();
  await eventually(()=>bridge.feedReady&&bridge.feedGap===undefined);
  assert.equal((await save(['mqtt','api','ws'])).statusCode,200);
  await eventually(()=>role('mqtt')==='active');
  const persisted=(await first.incoming({path:'/admin',headers})).json().bridges[0];
  assert.deepEqual(persisted.eventSources,['mqtt','api','ws']);
  assert.deepEqual(persisted.availableEventSources,['ws','mqtt','api']);
  await first.app.close();
  const second=await launch({bridges:[{...fixture.config,events:{primary:'ws'}}],database});
  t.after(()=>second.app.close());
  assert.deepEqual(second.runtime.bridges.get('lab').eventSources,['mqtt','api','ws']);
  await eventually(()=>second.runtime.bridges.get('lab').upstream().connections.find(item=>item.id==='mqtt')?.feed==='active');
  assert.equal(fixture.counts().writes,0);
});

test('camera ordering persists per account, is retryable, and cannot include a camera outside its grants', async t => {
  const bridge = await fixtureBridge();
  t.after(()=>bridge.close());
  const {app,runtime,incoming,seed,signIn} = await launch({bridges:[bridge.config]});
  t.after(()=>app.close());
  await seed({username:'order-admin',admin:true});
  const viewer = await seed({username:'order-viewer',admin:false});
  const adminHeaders = await signIn('order-admin'), viewerHeaders = await signIn('order-viewer');
  const list = async headers => (await incoming({path:'/cameras',headers})).json().cameras.map(c=>c.id);
  await eventually(async ()=>(await list(adminHeaders)).length===2);
  const [first,second] = await list(adminHeaders);
  const move = headers => incoming({path:'/cameras/order',method:'PUT',headers,payload:{earlier:second,later:first}});
  await runtime.sql.query('INSERT INTO grants VALUES ($1,$2,$3)',viewer,first,JSON.stringify(['view']));
  assert.equal((await move(viewerHeaders)).statusCode,404);
  await runtime.sql.query('INSERT INTO grants VALUES ($1,$2,$3)',viewer,second,JSON.stringify(['view']));
  assert.equal((await move({cookie:viewerHeaders.cookie})).statusCode,403);
  assert.deepEqual((await move(viewerHeaders)).json().order,[second,first]);
  assert.deepEqual((await move(viewerHeaders)).json().order,[second,first]);
  assert.deepEqual(await list(await signIn('order-viewer')),[second,first]);
  assert.deepEqual(await list(adminHeaders),[first,second]);
});

test('a PTZ preset photo requests a fresh bridge JPEG when MQTT capture is unavailable', async t => {
  const bridge = await fixtureBridge({previewCameras:['alpha']});
  t.after(()=>bridge.close());
  const {app,runtime,incoming,seed,signIn} = await launch({bridges:[bridge.config]});
  t.after(()=>app.close());
  await seed({username:'preset-jpeg',admin:true});
  const headers = await signIn('preset-jpeg');
  await eventually(()=>runtime.bridges.get('lab').feedReady);
  const {cameras}=(await incoming({path:'/cameras',headers})).json();
  const camera=cameras.find(c=>c.name==='Loading dock');
  assert.equal(camera.capabilities.capture,false);
  assert.equal(camera.capabilities.presetSnapshot,true);
  const path='/cameras/'+camera.id+'/ptz';
  const saved=await incoming({path,method:'POST',headers,payload:{operationId:uuid(),action:{op:'save_preset',preset_id:4,name:'Camera test'}}});
  assert.equal(saved.json().outcome,'confirmed');
  const baseline=bridge.previewRequests.length;
  const photo=await incoming({path:path+'/preset-snapshot',method:'POST',headers,payload:{operationId:uuid(),presetId:4}});
  assert.equal(photo.headers['content-type'],'image/jpeg',photo.body);
  assert.match(photo.headers['content-disposition'],/preset-4\.jpg/);
  assert.equal(photo.rawPayload.readUInt16BE(0),0xffd8);
  assert.deepEqual(bridge.previewRequests.slice(baseline).map(p=>[p.camera,p.refresh]),[['alpha',true]]);
});

test('preset shortcuts take a fresh photo after reported arrival and newer motion cancels a scheduled return', async t => {
  const bridge = await fixtureBridge({capture:true});
  t.after(()=>bridge.close());
  const {app,runtime,incoming,seed,signIn} = await launch({bridges:[bridge.config]});
  t.after(()=>app.close());
  await seed({username:'preset-operator',admin:true});
  const headers = await signIn('preset-operator');
  await eventually(()=>runtime.bridges.get('lab').feedReady);
  const [camera] = await runtime.sql.query("SELECT id FROM cameras WHERE remote_id='alpha'");
  const base='/cameras/'+camera.id+'/ptz';
  const ptz = action=>incoming({path:base,method:'POST',headers,payload:{operationId:uuid(),action}});
  const savePrefs = () => incoming({path:base+'/preferences',method:'PUT',headers,
    payload:{order:[3,2],returnPreset:3,returnSeconds:1}});
  const shoot = presetId=>incoming({path:base+'/preset-snapshot',method:'POST',headers,payload:{operationId:uuid(),presetId}});
  bridge.delayNextPreset();
  const savedPreset = (await ptz({op:'save_preset',preset_id:3,name:'Desk'})).json();
  assert.equal(savedPreset.outcome,'confirmed');
  assert.ok(savedPreset.data.presets.some(item=>item.id===3 && item.name==='Desk'));
  assert.equal((await savePrefs()).statusCode,200);
  assert.deepEqual((await ptz({op:'list_presets'})).json().data.preferences.order,[3,2]);
  assert.equal((await shoot(99)).json().reason,'PTZ_PRESET_MISSING');
  const photo = await shoot(2);
  assert.equal(photo.headers['content-type'],'image/png',photo.body);
  assert.deepEqual(photo.rawPayload,png());
  const returns=()=>bridge.requests.filter(entry=>entry.action?.op==='goto_preset' && entry.action?.preset_id===3).length;
  await eventually(()=>returns()===1,3500);
  const second = await shoot(2);
  assert.equal(second.statusCode,200);
  await ptz({op:'stop'});
  await new Promise(resolve=>setTimeout(resolve,1200));
  assert.equal(returns(),1);
  assert.equal((await shoot(2)).headers['content-type'],'image/png');
  await ptz({op:'delete_preset',preset_id:3});
  const afterDeletion = (await ptz({op:'list_presets'})).json().data;
  assert.equal(afterDeletion.presets.some(item=>item.id===3),false);
  assert.deepEqual(afterDeletion.preferences,{order:[2],returnPreset:null,returnSeconds:1});
  await seed({username:'preset-viewer',admin:false});
  const viewer=await signIn('preset-viewer');
  assert.equal((await incoming({path:base+'/preset-snapshot',method:'POST',headers:viewer,payload:{operationId:uuid(),presetId:2}})).statusCode,403);
});

test('PTZ distinguishes a confirmed stop from an unknown stop and reports when another position read is due', async t => {
  const bridge = await fixtureBridge();
  t.after(()=>bridge.close());
  const {app,runtime,incoming,seed,signIn} = await launch({bridges:[bridge.config]});
  t.after(()=>app.close());
  await seed({username:'ptz-operator',admin:true});
  const headers = await signIn('ptz-operator');
  await eventually(()=>runtime.bridges.get('lab').feedReady);
  const camera = (await incoming({path:'/admin',headers})).json().cameras[0].id;
  const ptz = (action,operationId=uuid())=>incoming({path:'/cameras/'+camera+'/ptz',method:'POST',headers,payload:{operationId,action}});
  const move = {op:'move',direction:'left',duration_ms:150};
  bridge.failNextPtzMove('PTZ_MOVE_START_FAILED');
  const stopped = (await ptz(move)).json();
  assert.equal(stopped.outcome,'unverified');
  assert.equal(stopped.data.stopped,true);
  assert.equal(stopped.data.startAcknowledged,false);
  assert.equal((await ptz(move)).statusCode,200);
  const uncertain=uuid();
  bridge.failNextPtzMove('PTZ_TIMED_STOP_FAILED');
  assert.equal((await ptz(move,uncertain)).json().outcome,'unknown');
  const immediate=(await ptz({op:'status'})).json();
  assert.ok(immediate.data.retryAfterMs>0 && immediate.data.retryAfterMs<=28_001);
  assert.equal((await ptz(move)).json().errorKey,'RECONCILE_REQUIRED');
  await runtime.sql.query('UPDATE operations SET started=$1 WHERE id=$2',Date.now()-29_000,uncertain);
  assert.equal((await ptz({op:'status'})).json().data.retryAfterMs,undefined);
  assert.equal((await ptz(move)).statusCode,200);
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
for (const eventHistory of historyBackends) test('camera rename preserves history, settings, and grants: '+eventHistory.backend, async t => {
  const fixture = await fixtureBridge();
  t.after(() => fixture.close());
  const {app, runtime, incoming, seed, signIn} = await launch({
    bridges:[{...fixture.config,cameraIds:[]}], eventHistory
  });
  t.after(() => app.close());
  await seed({username:'rename-admin',admin:true});
  const viewer = await seed({username:'rename-viewer'});
  const admin = await signIn('rename-admin');
  const headers = await signIn('rename-viewer');
  const bridge = runtime.bridges.get('lab');
  const sync = async () => { await bridge.refreshInventory(); await runtime.sync(); };
  await sync();
  const [camera] = await runtime.sql.query("SELECT * FROM cameras WHERE bridge_id='lab' AND remote_id='alpha'");
  assert.equal((await incoming({method:'PUT',path:'/admin/accounts/'+viewer+'/grants/'+camera.id,headers:admin,
    payload:{operationId:uuid(),preset:'viewer',allow:[],deny:[]}})).statusCode,200);
  assert.equal((await incoming({method:'PUT',path:'/cameras/'+camera.id+'/playback',headers:admin,
    payload:{operationId:uuid(),source:'direct',previewIntervalMs:7654,refreshOnAlert:'person'}})).statusCode,200);
  const history = async () => (await incoming({path:'/cameras/'+camera.id+'/events',headers})).json().events.map(item=>item.event.type);
  await eventually(() => bridge.feedReady && bridge.state('alpha').has('info'));
  fixture.event('alpha','before');
  await eventually(async () => (await history()).includes('before'));
  await fixture.reportInventory(['alpha','beta'],{alpha:'SERIAL-ONE'},{alpha:{identitySource:'serial',previousId:'alpha'}});
  await sync();
  assert.equal((await runtime.sql.query("SELECT id FROM cameras WHERE remote_id='SERIAL-ONE'"))[0].id,camera.id);
  assert.deepEqual(await history(),['before']);
  await fixture.reportInventory(['beta']);
  await sync();
  assert.equal((await incoming({path:'/cameras/'+camera.id+'/events',headers})).statusCode,404);
  await fixture.reportInventory(['garage','alpha'],{garage:'SERIAL-ONE',alpha:'REPLACEMENT'},{garage:{identitySource:'serial',previousId:'garage'},alpha:{identitySource:'serial',previousId:'alpha'}});
  await sync();
  await eventually(() => bridge.state('garage').has('info') && bridge.feedReady);
  await assert.rejects(bridge.command({camera:'alpha',stableId:'alpha',id:uuid(),command:{setting:'status_led',enabled:false},correlation:uuid()}),
    error=>error.key==='CAMERA_UNKNOWN');
  assert.equal(fixture.counts().writes,0);
  const cameras = (await incoming({path:'/cameras',headers})).json().cameras;
  assert.deepEqual(cameras.map(item=>item.id),[camera.id]);
  assert.equal(cameras[0].previewIntervalMs,7654);
  assert.equal(cameras[0].refreshOnAlert,'person');
  fixture.event('alpha','unrelated');
  fixture.event('garage','after');
  await eventually(async () => (await history()).includes('after'));
  assert.deepEqual(await history(),['before','after']);
  const [replacement] = await runtime.sql.query("SELECT * FROM cameras WHERE bridge_id='lab' AND remote_id='REPLACEMENT'");
  assert.notEqual(replacement.id,camera.id);
  assert.equal((await incoming({path:'/cameras/'+replacement.id+'/events',headers})).statusCode,403);
});
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
  const saved=(await next.incoming({path:settings,headers:nextHeaders})).json();
  assert.equal(saved.backend,eventHistory.backend);
  assert.equal(saved.limit,2);
  assert.equal(saved.storage.mode,'defaults');
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
  assert.deepEqual(state.json(),{source:'proxy',proxyUrl,previewIntervalMs:2000,refreshOnAlert:'off'});
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

test('retained state survives a serial change ahead of inventory and live video works independently of the event feed', async t => {
  const fixture = await fixtureBridge({ websocket:true, apiEvents:true });
  t.after(() => fixture.close());
  const { app, runtime, incoming, seed, signIn } = await launch({bridges:[{...fixture.config,events:['ws','mqtt','api']}]});
  t.after(() => app.close());
  await seed({username:'state-admin',admin:true});
  const headers = await signIn('state-admin');
  const bridge = runtime.bridges.get('lab');
  await bridge.refreshInventory();
  await eventually(() => bridge.upstream().connections.filter(item=>['ws','mqtt','api'].includes(item.id)).every(item=>item.state==='online'));
  await eventually(() => bridge.state('alpha').get('availability')?.online === true);
  const camera = (await incoming({path:'/cameras',headers})).json().cameras.find(item=>item.name==='Loading dock');
  const start = () => incoming({method:'POST',path:'/cameras/'+camera.id+'/media-sessions',headers,payload:{operationId:uuid(),stream:'sub'}});
  for (const payload of [{}, {online:false}]) {
    await fixture.snapshot('alpha','availability',payload);
    await eventually(() => bridge.state('alpha').has('availability') && bridge.state('alpha').get('availability').online === payload.online);
    assert.equal((await start()).statusCode,200);
  }
  const reads = fixture.counts().inventoryReads;
  await fixture.snapshot('alpha','availability',{stable_id:'SERIAL-ALPHA',online:true});
  await fixture.snapshot('alpha','state/person',{stable_id:'SERIAL-ALPHA',active:true});
  await eventually(() => fixture.counts().inventoryReads > reads);
  assert.equal(bridge.state('alpha').get('availability').online,false);
  assert.equal(bridge.state('alpha').has('state/person'),false);
  await fixture.reportInventory(['alpha','beta'],{alpha:'SERIAL-ALPHA'},{alpha:{identitySource:'serial',previousId:'alpha'}},false);
  await bridge.refreshInventory();
  await runtime.sync();
  for (const primary of ['ws','api','mqtt']) {
    bridge.setEventSources([primary,...['ws','api','mqtt'].filter(source=>source!==primary)]);
    await eventually(() => bridge.state('alpha').get('availability')?.online === true && bridge.state('alpha').get('state/person')?.active === true);
    assert.equal(bridge.state('alpha').get('availability').stable_id,'SERIAL-ALPHA');
  }
  const detail = (await incoming({path:'/cameras/'+camera.id,headers})).json();
  assert.equal(detail.availability.online,true);
  assert.ok(detail.detections.some(detection => detection.type === 'person' && detection.active === true));
});

test('an MQTT subscription filter does not hide newly discovered cameras from administrators', async t => {
  const fixture = await fixtureBridge({websocket:true, apiEvents:true, capture:true});
  t.after(() => fixture.close());
  await fixture.reportInventory(['alpha']);
  const mqtt = {...fixture.config.mqtt, cameraIds:['alpha']};
  const {app, runtime, incoming, seed, signIn} = await launch({bridges:[
    {...fixture.config, cameraIds:[], mqtt, events:['mqtt','ws','api']}
  ]});
  t.after(() => app.close());
  await seed({username:'scope-admin',admin:true});
  await seed({username:'scope-viewer'});
  const admin = await signIn('scope-admin');
  const viewer = await signIn('scope-viewer');
  const bridge = runtime.bridges.get('lab');
  await eventually(() => bridge.canCapture('alpha') && bridge.upstream().connections.find(item => item.id === 'ws')?.state === 'online');
  assert.equal((await incoming({path:'/cameras',headers:admin})).json().cameras.length,1);

  await fixture.reportInventory(['alpha','beta'], {beta:'SERIAL-BETA'}, {beta:{identitySource:'serial',previousId:'beta'}});
  const refreshed = await incoming({method:'POST',path:'/admin/bridges/lab/sync',headers:admin,payload:{operationId:uuid()}});
  assert.equal(refreshed.statusCode,200,refreshed.body);
  await fixture.snapshot('beta','info',{stable_id:'SERIAL-BETA',baichuan:{name:'E1 Pro'}});
  await fixture.snapshot('beta','availability',{stable_id:'SERIAL-BETA',online:true});
  await eventually(() => bridge.state('beta').get('availability')?.online);
  const visible = (await incoming({path:'/cameras',headers:admin})).json().cameras;
  assert.equal(visible.length,2);
  const enrolled = visible.find(item => item.name === 'E1 Pro');
  assert.ok(enrolled);
  assert.equal((await incoming({path:'/cameras/'+enrolled.id,headers:admin})).statusCode,200);
  assert.deepEqual((await incoming({path:'/cameras',headers:viewer})).json().cameras,[]);
  assert.equal((await incoming({path:'/cameras/'+enrolled.id,headers:viewer})).statusCode,403);
  assert.deepEqual(await runtime.sql.query('SELECT * FROM grants'),[]);
  assert.equal(bridge.stableId('beta'),'SERIAL-BETA');
  assert.equal(bridge.canCapture('beta'),false);
  const events = [];
  t.after(bridge.observe(update => { if (update.kind === 'event') events.push([update.camera,update.topic]); }));
  fixture.event('alpha','person',{},'mqtt');
  fixture.event('beta','pet',{},'ws');
  await eventually(() => events.length === 2);
  assert.deepEqual(events.sort(),[['alpha','person'],['beta','pet']]);
  bridge.setEventSources(['mqtt']);
  assert.equal(bridge.cameraFeedReady('beta'),false);
  assert.deepEqual(bridge.ids(),['alpha','beta']);
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

test('SD recordings enforce camera grants, serve byte ranges and verify image-setting readback', async t => {
  const fixture=await fixtureBridge({recordings:true});
  t.after(()=>fixture.close());
  const { app,runtime,incoming,seed,signIn }=await launch({bridges:[fixture.config]});
  t.after(()=>app.close());
  const admin=await seed({username:'recording-admin',admin:true});
  const viewer=await seed({username:'recording-viewer'});
  const privileged=await signIn('recording-admin');
  const restricted=await signIn('recording-viewer');
  await eventually(()=>runtime.bridges.get('lab').state('alpha').has('info'));
  const [camera]=await runtime.sql.query('SELECT id FROM cameras WHERE remote_id=$1','alpha');
  await runtime.sql.query('INSERT INTO grants VALUES ($1,$2,$3)',viewer,camera.id,JSON.stringify(['view','media.live']));
  const root='/cameras/'+camera.id;
  assert.equal((await incoming({path:root+'/storage',headers:restricted})).statusCode,403);
  const storage=await incoming({path:root+'/storage',headers:privileged});
  assert.equal(storage.statusCode,200,storage.body);
  assert.equal(storage.json().cards[0].totalBytes,64000000000);
  assert.equal(storage.json().cards[0].usedBytes,16000000000);
  assert.equal((await incoming({path:root+'/recordings?date=2026-02-30',headers:privileged})).statusCode,400);
  for (const [status, key, expected, error] of [
    [422,'API_SETTING_READ_FAILED',502,'STORAGE_READ_FAILED'],
    [502,'API_STORAGE_READ_FAILED',502,'STORAGE_READ_FAILED'],
    [504,'API_STORAGE_READ_FAILED',504,'STORAGE_READ_FAILED'],
    [422,'API_MEDIA_UNSUPPORTED',422,'UNSUPPORTED']
  ]) {
    fixture.setStorageFailure({status,key});
    const failure=await incoming({path:root+'/storage',headers:privileged});
    assert.equal(failure.statusCode,expected);
    assert.equal(failure.json().errorKey,error);
    assert.deepEqual(failure.json().details,{upstreamStatus:status,bridgeCorrelationId:failure.json().correlationId});
    assert.ok(!failure.body.includes(serviceToken));
  }
  const search=await incoming({path:root+'/recordings?date=2026-11-17&stream=sub',headers:privileged});
  assert.equal(search.statusCode,200,search.body);
  const recording=search.json().recordings[0];
  const exportPath=root+'/recordings/export?date=2026-11-17&kind=';
  assert.equal((await incoming({path:exportPath+'photos',headers:restricted})).statusCode,403);
  assert.equal((await incoming({path:exportPath+'photos&from=20:00:00&to=01:00:00',headers:privileged})).statusCode,400);
  assert.equal((await incoming({path:exportPath+'photos&from=00:00:00&to=01:00:00',headers:privileged})).json().count,0);
  const gallery=root+'/time-lapse/photos';
  const day='?date=2026-11-17';
  const thumbnail=(id)=>gallery+'/'+id+'/preview'+day;
  assert.equal((await incoming({path:gallery+day,headers:restricted})).statusCode,403);
  assert.equal((await incoming({path:gallery+'?date=2026-02-30',headers:privileged})).statusCode,400);
  await runtime.sql.query('UPDATE grants SET permissions=$1 WHERE account_id=$2 AND camera_id=$3',JSON.stringify(['view','recordings.view']),viewer,camera.id);
  const photoList=(await incoming({path:gallery+day,headers:restricted})).json();
  assert.deepEqual(photoList.photos.map(p=>p.capturedAt),['2026-11-17T09:15:00','2026-11-17T12:45:00']);
  assert.equal((await incoming({path:exportPath+'photos',headers:restricted})).statusCode,403);
  fixture.expireNextPhoto();
  for (const photo of photoList.photos) {
    const image=await incoming({path:thumbnail(photo.id),headers:restricted});
    assert.equal(image.statusCode,200);
    assert.equal(image.headers['content-type'],'image/jpeg');
    assert.equal(image.rawPayload.readUInt16BE(),0xffd8);
  }
  const legacy = (await incoming({path:gallery+'?date=2026-11-18',headers:restricted})).json();
  assert.equal(legacy.undatedCount,1);
  assert.equal(legacy.photos.length,0);
  const find=async(second,radius)=>incoming({path:gallery+'/nearest?date=2026-11-18&second='+second+'&radius='+radius,headers:restricted});
  assert.deepEqual((await find(37_806,20)).json().photo,{id:'3'.repeat(64),capturedAt:'2026-11-18T10:30:00'});
  assert.equal((await find(37_806,2)).json().photo,null);
  assert.equal((await incoming({path:gallery+'?date=2026-11-21',headers:restricted})).json().photos.length,0);
  await runtime.sql.query('UPDATE grants SET permissions=$1 WHERE account_id=$2 AND camera_id=$3',JSON.stringify(['view','media.live']),viewer,camera.id);
  assert.equal((await incoming({path:thumbnail(photoList.photos[0].id),headers:restricted})).statusCode,403);
  const archive=async (kind,types) => {
    const answer=await incoming({path:exportPath+kind+'&download=1',headers:privileged});
    assert.equal(answer.statusCode,200,answer.statusCode===200?'':answer.body);
    assert.equal(answer.headers['content-type'],'application/zip');
    const check=spawnSync('python3',['-c',[
      'import zipfile,io,sys,json',
      'z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))',
      'assert z.testzip() is None',
      'print(json.dumps([[n,z.read(n)[:8].hex()] for n in z.namelist()]))'
    ].join('\n')],{input:answer.rawPayload,encoding:'utf8'});
    assert.equal(check.status,0,check.stderr);
    const entries=JSON.parse(check.stdout);
    assert.equal(entries.length,types.length);
    for(const [i,[name,signature]] of entries.entries()){
      assert.match(name,types[i]);
      if(name.endsWith('.png'))assert.equal(signature,'89504e470d0a1a0a');
      else assert.match(signature,/66747970$/);
    }
  };
  await archive('photos',[/09-15-00.*\.png$/,/12-45-00.*\.png$/]);
  await archive('photos&from=09:00:00&to=09:30:00',[/09-15-00.*\.png$/]);
  await archive('videos',[/^main\/.*\.mp4$/,/^sub\/.*\.mp4$/]);
  const path=root+'/recordings/'+recording.id+'/video';
  const previewPath=root+'/recordings/'+recording.id+'/preview';
  await runtime.sql.query('UPDATE grants SET permissions=$1 WHERE account_id=$2 AND camera_id=$3',JSON.stringify(['view','recordings.view']),viewer,camera.id);
  assert.equal((await incoming({path:path+'?download=1',headers:restricted})).statusCode,403);
  const download = await incoming({path:path+'?download=1&name=clip-sub',headers:privileged});
  assert.equal(download.headers['content-disposition'],'attachment; filename="clip-sub.mp4"');
  await runtime.sql.query('UPDATE grants SET permissions=$1 WHERE account_id=$2 AND camera_id=$3',JSON.stringify(['view','media.live']),viewer,camera.id);
  assert.equal((await incoming({path:previewPath,headers:restricted})).statusCode,403);
  const preview=await incoming({path:previewPath,headers:privileged});
  assert.equal(preview.statusCode,200,preview.body);
  assert.equal(preview.headers['content-type'],'image/jpeg');
  assert.equal(preview.rawPayload[0],255);assert.equal(preview.rawPayload[1],216);
  assert.equal((await incoming({path:previewPath+'?offsetMs=-1',headers:privileged})).statusCode,400);
  assert.equal((await incoming({path:previewPath+'?offsetMs=86400001',headers:privileged})).statusCode,400);
  assert.equal((await incoming({path:previewPath+'?offsetMs=1000',headers:privileged})).statusCode,200);
  const recoveredPreview=await incoming({path:previewPath+'?offsetMs=42000',headers:privileged});
  assert.equal(recoveredPreview.statusCode,200);
  assert.equal(recoveredPreview.headers['x-preview-offset-ms'],'34000');
  const upstreamReads = fixture.recordingRequests.filter(r=>r.kind==='preview').length;
  const sameFrame = await incoming({path:previewPath+'?offsetMs=42000',headers:privileged});
  assert.equal(sameFrame.headers['x-preview-offset-ms'],'34000');
  assert.ok(sameFrame.rawPayload.equals(recoveredPreview.rawPayload));
  assert.equal((await incoming({path:previewPath+'?offsetMs=42000',headers:restricted})).statusCode,403);
  await runtime.sql.query('UPDATE grants SET permissions=$1 WHERE account_id=$2 AND camera_id=$3',JSON.stringify(['view','recordings.view']),viewer,camera.id);
  assert.ok((await incoming({path:previewPath+'?offsetMs=42000',headers:restricted})).rawPayload.equals(recoveredPreview.rawPayload));
  await runtime.sql.query('UPDATE grants SET permissions=$1 WHERE account_id=$2 AND camera_id=$3',JSON.stringify(['view','media.live']),viewer,camera.id);
  assert.equal(fixture.recordingRequests.filter(r=>r.kind==='preview').length,upstreamReads);
  const metadataPath=root+'/recordings/'+recording.id+'/metadata';
  assert.equal((await incoming({path:metadataPath,headers:restricted})).statusCode,403);
  const metadata=await incoming({path:metadataPath,headers:privileged});
  assert.equal(metadata.statusCode,200,metadata.body);
  assert.equal(metadata.json().frames[0].objects[0].bounding_box.left,.1);

  assert.equal((await incoming({path,headers:restricted})).statusCode,403);
  const partial=await incoming({path,headers:{...privileged,range:'bytes=0-31'}});
  assert.equal(partial.statusCode,206,partial.body);
  assert.equal(partial.rawPayload.length,32);
  assert.match(partial.headers['content-range'],/^bytes 0-31\/\d+$/);
  const invalid=await incoming({path,headers:{...privileged,range:'bytes=9999999-'}});
  assert.equal(invalid.statusCode,416);
  assert.equal((await incoming({path:root+'/recordings/'+recording.id+'/video',headers:{...privileged,range:'bytes=0-1,4-8'}})).statusCode,400);
  assert.equal((await incoming({path:root+'/settings/image',headers:restricted,method:'PATCH',payload:{
    operationId:uuid(),change:{setting:'image_orientation',action:'hflip'}
  }})).statusCode,403);
  for(const action of ['hflip','vflip','clockwise','counterclockwise']) {
    const update=await incoming({path:root+'/settings/image',headers:privileged,method:'PATCH',payload:{
      operationId:uuid(),change:{setting:'image_orientation',action}
    }});
    assert.equal(update.statusCode,200,update.body);
    assert.equal(update.json().outcome,'confirmed');
  }
  assert.equal((await incoming({path:root+'/users',headers:restricted})).statusCode,403);
  fixture.rejectNextDisplay();
  const oldBridge = await incoming({path:root+'/display',headers:privileged,method:'PUT',payload:{
    operationId:uuid(),fields:{watermark:false,background:true}
  }});
  assert.equal(oldBridge.statusCode,422);
  assert.equal(oldBridge.json().reason,'CAMERA_DISPLAY_REJECTED');
  assert.equal(oldBridge.json().cameraStatus,undefined);
  assert.ok(oldBridge.json().bridgeCorrelationId);
  const operationId = uuid();
  const saveOverlay = () => incoming({path:root+'/display',headers:privileged,method:'PUT',payload:{
    operationId,fields:{watermark:false,background:true}
  }});
  fixture.rejectNextDisplay(403);
  const deniedOverlay = (await saveOverlay()).json();
  const replayedOverlay = (await saveOverlay()).json();
  const storedOverlay = (await incoming({path:'/operations/'+operationId,headers:privileged})).json();
  for (const result of [deniedOverlay,replayedOverlay,storedOverlay]) {
    assert.equal(result.reason,'CAMERA_DISPLAY_REJECTED');
    assert.equal(result.cameraStatus,403);
    assert.equal(result.bridgeCorrelationId,deniedOverlay.bridgeCorrelationId);
  }
  const encodingPath=root+'/encoding';
  assert.equal((await incoming({path:encodingPath,headers:restricted})).statusCode,403);
  const changeEncoder=(settings,headers=privileged)=>incoming({path:encodingPath,method:'PUT',headers,payload:{stream:'sub',settings,operationId:uuid()}});
  assert.equal((await changeEncoder({fps:10},restricted)).statusCode,403);
  assert.equal((await changeEncoder({width:640})).statusCode,400);
  assert.equal((await changeEncoder({fps:999})).json().outcome,'rejected');
  const updatedEncoder=(await changeEncoder({fps:10})).json();
  assert.equal(updatedEncoder.outcome,'confirmed');
  const {profiles}= (await incoming({path:encodingPath,headers:privileged})).json();
  assert.deepEqual(profiles.map(p=>p.current.fps),[20,10,15]);
  const clockPath=root+'/clock';
  assert.equal((await incoming({path:clockPath,headers:restricted})).statusCode,403);
  assert.equal((await incoming({path:clockPath,headers:privileged})).json().cameraTime,'2026-11-19T07:05:02');
  const adjust=(value,headers=privileged)=>incoming({path:clockPath,headers,method:'PUT',payload:{operationId:uuid(),cameraTime:value}});
  assert.equal((await adjust('2026-02-30T06:05:09')).statusCode,400);
  assert.equal((await adjust('2026-11-19T06:05:09',restricted)).statusCode,403);
  assert.equal((await adjust('2026-11-19T06:05:09')).json().outcome,'confirmed');
  assert.equal((await incoming({path:clockPath,headers:privileged})).json().cameraTime,'2026-11-19T06:05:09');
  const networkPath=root+'/network';
  const rtspPath=networkPath+'/rtsp';
  assert.equal((await incoming({path:rtspPath,headers:restricted})).statusCode,403);
  assert.equal((await incoming({path:rtspPath,headers:restricted,method:'PUT',payload:{operationId:uuid(),enabled:true}})).statusCode,403);
  const rtspRead=await incoming({path:rtspPath,headers:privileged});
  assert.deepEqual(rtspRead.json(),{supported:true,enabled:false,port:8554});
  const changeRtsp=await incoming({path:rtspPath,headers:privileged,method:'PUT',payload:{operationId:uuid(),enabled:true}});
  assert.equal(changeRtsp.json().outcome,'confirmed',changeRtsp.body);
  assert.deepEqual((await incoming({path:rtspPath,headers:privileged})).json(),{supported:true,enabled:true,port:8554});
  assert.equal((await incoming({path:networkPath,headers:restricted})).statusCode,403);
  const networkRead=await incoming({path:networkPath,headers:privileged});
  assert.equal(networkRead.json().wifi.ssid,'Fixture LAN',networkRead.body);
  assert.ok(!networkRead.body.includes('should-never-leave-the-bridge'));
  assert.deepEqual(networkRead.json().interfaces.ethernet.addresses,['192.0.2.3']);
  assert.deepEqual(networkRead.json().interfaces.wifi.addresses,['192.0.2.4']);
  assert.equal(networkRead.json().wifiSignal,-47);
  const toggle=(enabled,headers=privileged)=>incoming({path:networkPath+'/wifi',headers,method:'PUT',payload:{operationId:uuid(),confirmation:true,enabled}});
  assert.equal((await toggle(false,restricted)).statusCode,403);
  assert.equal((await toggle(false)).json().outcome,'confirmed');
  assert.equal((await incoming({path:networkPath,headers:privileged})).json().interfaces.wifi.enabled,false);
  assert.equal((await toggle(true)).json().outcome,'confirmed');
  const wifi={operationId:uuid(),ssid:'New Wi-Fi & Lab',password:'fixture-only-wpa',open:false,confirmation:true};
  const setWifi=(payload,headers=privileged)=>incoming({path:networkPath,headers,method:'PUT',payload});
  assert.equal((await setWifi(wifi,restricted)).statusCode,403);
  assert.equal((await setWifi({...wifi,ssid:'é'.repeat(17)})).statusCode,400);
  assert.equal((await setWifi({...wifi,password:''})).statusCode,400);
  const stored=await setWifi(wifi);
  assert.equal(stored.json().outcome,'confirmed',stored.body);
  assert.ok(!stored.body.includes(wifi.password));
  assert.equal((await incoming({path:networkPath,headers:privileged})).json().wifi.ssid,wifi.ssid);
  assert.equal((await setWifi(wifi)).json().outcome,'confirmed');
  assert.equal((await setWifi({...wifi,password:'new-test-password'})).statusCode,409);
  assert.equal((await setWifi({...wifi,operationId:uuid(),ssid:'Disconnect'})).json().outcome,'unknown');
  const masked=(await setWifi({...wifi,operationId:uuid(),ssid:'Masked firmware'})).json();
  assert.equal(masked.outcome,'unverified');
  assert.deepEqual(masked.data,{ssidVerified:true});
  const listed = (await incoming({path:root+'/users',headers:privileged})).json();
  assert.equal(listed.users[0].username,'admin');
  assert.equal(listed.users[0].bridgeLogin,true);
  assert.ok(!JSON.stringify(listed).includes('redacted-fixture'));
  assert.equal(listed.manageAccounts, true);
  const add = {operationId:uuid(),action:'add',role:'user',username:'new-user',password:'private-fixture-32',uid:'FIXTUREUID',confirmation:true};
  const remove = {operationId:uuid(),action:'remove',username:add.username,uid:add.uid,confirmation:true};
  const manage = (body, headers=privileged) => incoming({path:root+'/users',method:'POST',headers,payload:body});
  for (const attempt of [add,remove]) assert.equal((await manage(attempt,restricted)).statusCode,403);
  assert.equal((await manage({...remove,password:add.password})).statusCode,400);
  assert.equal((await manage({...add,confirmation:false})).statusCode,400);
  const created = await manage(add);
  assert.equal(created.json().data.status,'verified',created.body);
  assert.ok(!created.body.includes(add.password));
  assert.equal((await manage(add)).json().outcome,'confirmed');
  assert.equal((await manage({...add,password:'changed-fixture-99'})).statusCode,409);
  const after = (await incoming({path:root+'/users',headers:privileged})).json().users;
  assert.deepEqual(after.find(u=>u.username===add.username),{username:add.username,administrator:false,bridgeLogin:false});
  const rejected=await manage({...remove,operationId:uuid(),username:'admin'});
  assert.equal(rejected.json().reason,'CAMERA_ACCOUNT_REJECTED');
  assert.equal((await manage(remove)).json().data.status,'verified');
  assert.deepEqual((await incoming({path:root+'/users',headers:privileged})).json().users,listed.users);
  const operations=await runtime.sql.query('SELECT * FROM operations WHERE id=$1',add.operationId);
  assert.equal(operations.length,1); assert.ok(!JSON.stringify(operations).includes(add.password));
  const payload = {operationId:uuid(),username:'admin',password:'fixture-password-99',uid:'FIXTUREUID',confirmation:true};
  assert.equal((await incoming({path:root+'/users/password',headers:restricted,method:'POST',payload})).statusCode,403);
  const changed = await incoming({path:root+'/users/password',headers:privileged,method:'POST',payload});
  assert.equal(changed.json().data.status,'restart-required',changed.body);
  assert.ok(!changed.body.includes(payload.password));
  assert.equal((await incoming({path:root+'/users/password',headers:privileged,method:'POST',payload:{...payload,password:'different-fixture-99'}})).statusCode,409);
  const orientation=await incoming({path:root+'/settings/image?fresh=true',headers:privileged});
  assert.deepEqual(orientation.json().values.image,{hflip:true,vflip:true,rotation:0});
  const correlation=uuid();
  fixture.setRecordingFailure({status:502,stage:'conversion',correlation});
  const failed=await incoming({path,headers:privileged});
  assert.equal(failed.statusCode,502);
  assert.deepEqual(failed.json().details,{upstreamStatus:502,bridgeCorrelationId:correlation,playbackReason:'conversion'});
  assert.ok(!failed.body.includes(serviceToken));
  fixture.setRecordingFailure({status:413,stage:'cache-limit',correlation});
  assert.equal((await incoming({path,headers:privileged})).statusCode,413);
  assert.ok(admin);
});

test('multiple bridge connections persist, retain secrets and isolate cameras and callbacks', async t => {
  const a=await fixtureBridge();
  const b=await fixtureBridge({websocket:true,apiEvents:true,token:'other-bridge-fixture-token-4433',namePrefix:'Remote '});
  t.after(()=>a.close()); t.after(()=>b.close());
  const directory=await mkdtemp(join(tmpdir(),'wui-bridge-settings-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const database={driver:'sqlite',path:join(directory,'app.sqlite')};
  const apps=[];
  t.after(async()=>{for(const app of apps) await app.app.close();});
  const first=await launch({bridges:[a.config],database});apps.push(first);
  await first.seed({username:'bridge-admin',admin:true});
  await first.seed({username:'bridge-viewer'});
  const headers=await first.signIn('bridge-admin'), denied=await first.signIn('bridge-viewer');
  const original=first.runtime.bridges.get('lab');
  const configuration={...b.config,id:'remote',label:'Remote bridge',mqtt:undefined,events:undefined};
  const addId=uuid();
  const add=(auth=headers)=>first.incoming({method:'POST',path:'/admin/bridges',headers:auth,payload:{operationId:addId,configuration}});
  assert.equal((await add(denied)).statusCode,403);
  const added=await add();assert.equal(added.statusCode,200,added.body);
  assert.equal((await add()).json().outcome,'confirmed');
  assert.equal(first.runtime.bridges.size,2);
  await eventually(()=>first.runtime.bridges.get('remote').feedReady);
  assert.equal(first.runtime.bridges.get('lab'),original);
  const admin=(await first.incoming({path:'/admin',headers})).json();
  assert.equal(admin.bridges.length,2);
  assert.ok(!JSON.stringify(admin).includes(b.config.http.token));
  assert.ok(admin.bridges.find(item=>item.id==='remote').connections.http.tokenConfigured);
  const cameras=admin.cameras;
  const alpha=cameras.find(item=>item.bridge==='lab'&&item.label==='Loading dock').id;
  const remote=cameras.find(item=>item.bridge==='remote'&&item.label==='Remote Loading dock').id;
  assert.notEqual(alpha,remote);
  b.event('alpha','remote-event');
  await eventually(async()=>(await first.incoming({path:'/cameras/'+remote+'/events',headers})).json().events.some(item=>item.event.type==='remote-event'));
  assert.equal((await first.incoming({path:'/cameras/'+alpha+'/events',headers})).json().events.length,0);
  const callback=(bridge,camera,id)=>first.incoming({
    method:'POST',path:'/admin/bridges/'+bridge+'/callbacks',headers,
    payload:{operationId:uuid(),action:'add',id,destination:'fixture',events:['person'],cameras:[camera]}
  });
  assert.equal((await callback('remote',remote,'remote-only')).json().outcome,'confirmed');
  assert.equal((await callback('remote',alpha,'wrong-bridge')).json().reason,'CALLBACK_INVALID');
  assert.equal((await callback('lab',alpha,'local-only')).json().outcome,'confirmed');
  const callbacks=async id=>(await first.incoming({path:'/admin/bridges/'+id+'/callbacks',headers})).json().callbacks;
  assert.deepEqual((await callbacks('remote')).map(item=>item.id),['remote-only']);
  assert.deepEqual((await callbacks('lab')).map(item=>item.id),['local-only']);
  const update=config=>first.incoming({method:'PUT',path:'/admin/bridges/remote',headers,payload:{operationId:uuid(),configuration:config}});
  const editable={...b.config,id:'remote',label:'Remote bridge',events:undefined,http:{url:b.config.http.url}};
  assert.equal((await update({...editable,id:'different-bridge'})).statusCode,400);
  assert.equal((await update(editable)).json().outcome,'confirmed');
  const sources=await first.incoming({method:'PUT',path:'/admin/bridges/remote/event-sources',headers,
    payload:{operationId:uuid(),sources:['mqtt','api','ws']}});
  assert.equal(sources.statusCode,200,sources.body);
  const nextToken='new-bridge-fixture-token-554433';
  const edits=await Promise.all([
    update({...editable,http:{url:b.config.http.url,token:nextToken}}),
    update({...editable,label:'Remote bridge edited'})
  ]);
  for(const response of edits) assert.equal(response.json().outcome,'confirmed',response.body);
  const [row]=await first.runtime.sql.query('SELECT connection_config FROM bridges WHERE id=$1','remote');
  assert.equal(JSON.parse(row.connection_config).http.token,nextToken);
  assert.equal(JSON.parse(row.connection_config).label,'Remote bridge edited');
  assert.equal(first.runtime.bridges.get('lab'),original);
  assert.equal((await update({...editable,label:'Remote bridge edited',http:{url:b.config.http.url,token:b.config.http.token}})).json().outcome,'confirmed');
  await first.app.close();apps.splice(apps.indexOf(first),1);
  const second=await launch({bridges:[a.config],database});apps.push(second);
  assert.equal(second.runtime.bridges.size,2);
  const saved=second.runtime.bridges.get('remote');
  assert.equal(saved.config.label,'Remote bridge edited');
  assert.equal(saved.config.http.token,b.config.http.token);
  assert.deepEqual(saved.eventSources,['mqtt','api','ws']);
  await eventually(()=>saved.feedReady);
  assert.equal(a.counts().writes,0);assert.equal(b.counts().writes,0);
});

if(process.env.WUI_TEST_VALKEY) test('event storage overrides defaults, keeps passwords private and remains editable while offline', async t => {
  const fixture=await fixtureBridge();t.after(()=>fixture.close());
  const directory=await mkdtemp(join(tmpdir(),'wui-valkey-settings-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const database={driver:'sqlite',path:join(directory,'app.sqlite')};
  const apps=[];t.after(async()=>{for(const app of apps) await app.app.close();});
  const boot={bridges:[fixture.config],database,eventHistory:{backend:'memory',retention:4}};
  const first=await launch(boot);apps.push(first);
  await first.seed({username:'cache-admin',admin:true});
  await first.seed({username:'cache-viewer'});
  let headers=await first.signIn('cache-admin');
  const denied=await first.signIn('cache-viewer');
  await eventually(()=>first.runtime.bridges.get('lab').state('alpha').has('info'));
  const camera=(await first.incoming({path:'/admin',headers})).json().cameras.find(item=>item.label==='Loading dock').id;
  let active=first;
  const get=async()=>(await active.incoming({path:'/admin/event-history',headers})).json();
  const set=(storage,limit=4,auth=headers)=>active.incoming({method:'PUT',path:'/admin/event-history',headers:auth,
    payload:{operationId:uuid(),limit,storage}});
  const read=async()=>(await active.incoming({path:'/cameras/'+camera+'/events',headers})).json();
  assert.equal((await get()).storage.mode,'defaults');
  const [owner]=await first.runtime.sql.query('SELECT id FROM accounts WHERE username=$1','cache-admin');
  const legacyOperation=uuid();
  await first.runtime.ops.run({
    id:legacyOperation,actor:owner.id,resource:'event-history',action:'event-history.resize',
    correlation:uuid(),input:4,execute:async()=>({outcome:'confirmed'})
  });
  const replay=await first.incoming({method:'PUT',path:'/admin/event-history',headers,payload:{operationId:legacyOperation,limit:4}});
  assert.equal(replay.json().outcome,'confirmed',replay.body);

  const privateUrl=new URL(process.env.WUI_TEST_VALKEY), publicUrl=new URL(privateUrl);
  const password=decodeURIComponent(privateUrl.password);publicUrl.password='';
  const valkey={url:publicUrl.href,password,keyPrefix:'settings-test-'+uuid()};
  const probe=(payload,auth=headers)=>active.incoming({method:'POST',path:'/admin/event-history/test',headers:auth,payload});
  const candidate={mode:'valkey',valkey:{url:publicUrl.href,password}};
  assert.equal((await probe(candidate,denied)).statusCode,403);
  const {['x-csrf-token']:csrf,...withoutCsrf}=headers;
  assert.equal((await probe(candidate,withoutCsrf)).statusCode,403);
  assert.equal((await probe({mode:'defaults'})).statusCode,400);
  const ping=await probe(candidate);
  assert.equal(ping.json().connected,true,ping.body);assert.ok(ping.json().elapsedMs>=0);
  if(password) {
    assert.ok(!ping.body.includes(password));
    assert.deepEqual((await probe({mode:'valkey',valkey:{url:publicUrl.href,password:'invalid-password'}})).json(),
      {connected:false,failure:'authorization'});
  }
  assert.deepEqual((await probe({mode:'valkey',valkey:{url:new URL('/999999',publicUrl).href,password}})).json(),
    {connected:false,failure:'database'});
  assert.equal((await get()).storage.mode,'defaults');
  assert.equal((await set({mode:'valkey',valkey},4,denied)).statusCode,403);
  const configured=await set({mode:'valkey',valkey});
  assert.equal(configured.json().outcome,'confirmed',configured.body);
  if(password) assert.ok(!configured.body.includes(password));
  let settings=await get();assert.equal(settings.backend,'valkey');assert.equal(settings.connected,true);
  assert.equal(settings.storage.valkey.passwordConfigured,Boolean(password));
  fixture.event('alpha','cached-in-valkey');
  await eventually(async()=>(await read()).events?.at(-1)?.event.type==='cached-in-valkey');
  const keepPassword={url:publicUrl.href,keyPrefix:valkey.keyPrefix};
  assert.equal((await set({mode:'valkey',valkey:keepPassword},5)).json().outcome,'confirmed');
  assert.equal((await read()).events.at(-1).event.type,'cached-in-valkey');
  assert.equal((await set({mode:'memory'},5)).json().outcome,'confirmed');
  settings=await get();assert.equal(settings.storage.mode,'memory');
  assert.equal(settings.storage.valkey.passwordConfigured,Boolean(password));
  await first.app.close();apps.splice(apps.indexOf(first),1);
  const fileDefaults={backend:'valkey',url:privateUrl.href,keyPrefix:'file-defaults-'+uuid(),retention:2};
  active=await launch({...boot,eventHistory:fileDefaults});apps.push(active);
  headers=await active.signIn('cache-admin');
  settings=await get();
  assert.equal((await probe({mode:'defaults'})).json().connected,true);
  assert.equal((await probe({mode:'valkey',valkey:{url:publicUrl.href}})).json().connected,true);
  assert.equal(settings.backend,'memory');assert.equal(settings.defaults.backend,'valkey');
  assert.equal(settings.limit,5);assert.equal(settings.storage.mode,'memory');
  assert.equal((await set({mode:'valkey',valkey:keepPassword},5)).json().outcome,'confirmed');
  assert.equal((await read()).events.at(-1).event.type,'cached-in-valkey');
  assert.equal((await set({mode:'defaults'},5)).json().outcome,'confirmed');
  settings=await get();assert.equal(settings.defaults.valkey.keyPrefix,fileDefaults.keyPrefix);
  assert.equal(settings.backend,'valkey');assert.equal(settings.storage.mode,'defaults');
  if(password) assert.ok(!JSON.stringify(settings).includes(password));
  assert.equal((await read()).events.length,0);
  const lease=tcp().listen(0,'127.0.0.1');await once(lease,'listening');
  const closedPort=lease.address().port;await new Promise(resolve=>lease.close(resolve));
  const unavailable={url:'redis://127.0.0.1:'+closedPort+'/0',keyPrefix:'offline-settings-'+uuid()};
  assert.deepEqual((await probe({mode:'valkey',valkey:{url:unavailable.url}})).json(),{connected:false,failure:'transport'});
  assert.equal((await get()).backend,'valkey');assert.equal((await get()).connected,true);
  assert.equal((await set({mode:'valkey',valkey:unavailable},5)).json().outcome,'confirmed');
  settings=await get();assert.equal(settings.connected,false);assert.equal(settings.storage.mode,'valkey');
  assert.equal((await set({mode:'memory'},5)).json().outcome,'confirmed');
  assert.equal((await get()).connected,true);
});

test('recording playback is gated independently from card details and recording searches', async t => {
  const fixture=await fixtureBridge({recordings:true});t.after(()=>fixture.close());
  const {app,runtime,incoming,seed,signIn}=await launch({bridges:[fixture.config]});t.after(()=>app.close());
  await seed({username:'workspace-admin',admin:true});const headers=await signIn('workspace-admin');
  await eventually(()=>runtime.bridges.get('lab').hasRecordings('alpha'));
  const {cameras}= (await incoming({path:'/cameras',headers})).json();
  const camera=cameras.find(item=>item.name==='Loading dock').id;
  const root='/cameras/'+camera;
  fixture.setPlaybackAvailable(false);
  await runtime.ready();
  const unavailable=(await incoming({path:'/cameras',headers})).json().cameras.find(item=>item.id===camera);
  assert.equal(unavailable.capabilities.recordings,true);
  assert.equal(unavailable.capabilities.recordingPlayback,false);
  const storage=await incoming({path:root+'/storage',headers});
  assert.equal(storage.statusCode,200,storage.body);
  assert.equal(storage.json().playbackAvailable,false);
  assert.equal((await incoming({path:root+'/recordings?date=2026-11-17&stream=sub',headers})).statusCode,200);
  assert.equal((await incoming({path:root+'/recordings/'+'a'.repeat(64)+'/video',headers})).statusCode,422);
  fixture.setPlaybackAvailable(true);await runtime.ready();
  assert.equal((await incoming({path:'/cameras',headers})).json().cameras.find(item=>item.id===camera).capabilities.recordingPlayback,true);
});

test('PNG gap choices merge overlapping streams and keep camera-local day boundaries',()=>{
  const date='2026-11-17', at=time=>date+'T'+time;
  assert.deepEqual(recordingGaps(date,[{start:at('09:00:03'),end:at('10:00:00')},{start:at('08:59:59'),end:at('09:59:58')},{start:at('23:59:58'),end:'2026-11-18T00:00:04'}]),[
    {from:'00:00:00',to:'08:59:58'},{from:'10:00:01',to:'23:59:57'}
  ]);
});
