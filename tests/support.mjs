import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { crc32, deflateSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as tcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'mqtt';
import { WebSocketServer } from 'ws';
import { api } from '../dist/server/api.js';
import { passwordHash } from '../dist/server/auth.js';
import { configSchema } from '../dist/server/config.js';

export const publicOrigin = 'http://127.0.0.1:4900';
export const localPassword = 'fixture-password-882';
export const serviceToken = 'some-fixture-token-for-local-tests';
export const hop = 'some-fixture-hop-token-for-local-tests';
export const uuid = () => randomUUID();

export const eventually = async (check, ms = 9000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await setTimeout(40);
  }
  assert.fail('fixture did not reach the expected state');
};

export const launch = async ({
  auth = { mode: 'local' }, proxy = false, bridges = [], eventHistory,
  database = { driver: 'sqlite', path: ':memory:' }, sessionMinutes, localSessionMinutes, logging
} = {}) => {
  const config = configSchema.parse({
    auth, database, publicOrigin, bridges, eventHistory, sessionMinutes, localSessionMinutes, logging,
    ...(proxy ? {
      httpApi: { mode: 'proxy', proxy: { basePath: '/front', upstreamBaseUrl: 'http://127.0.0.1:8080', upstreamBasePath: '/private' } },
      forward: { secret: hop, peers: ['127.0.0.1'] }
    } : {})
  });
  const { app, runtime } = await api({ config });
  const base = proxy ? '/private/v1' : '/api/v1';
  const incoming = ({ path, ...options }) => app.inject({
    remoteAddress: '127.0.0.1',
    ...options,
    headers: { ...(proxy ? { 'x-wui-forward-proof': hop } : {}), origin: publicOrigin, ...options.headers },
    url: base + path
  });
  const seed = async ({ username, admin = false, label = 'Fixture user', issuer, subject }) => {
    const id = uuid();
    const encoded = username ? await passwordHash({ password: localPassword }) : null;
    await runtime.sql.query('INSERT INTO accounts(id,label,username,password_hash,admin,enabled) VALUES ($1,$2,$3,$4,$5,1)', id, label, username ?? null, encoded, Number(admin));
    if (issuer) await runtime.sql.query('INSERT INTO identities(issuer,subject,account_id) VALUES ($1,$2,$3)', issuer, subject, id);
    return id;
  };
  const signIn = async (name) => {
    const response = await incoming({ method: 'POST', path: '/session/local', payload: { username: name, password: localPassword } });
    assert.equal(response.statusCode, 200, response.body);
    const session = response.json();
    const cookie = response.cookies[0];
    assert.ok(cookie.httpOnly && cookie.secure && cookie.sameSite === 'Lax');
    return { cookie: cookie.name + '=' + cookie.value, 'x-csrf-token': session.csrf };
  };
  return { app, runtime, config, seed, signIn, incoming, base };
};

const caps = {
  baichuan: { controls: {
    leds: { status_led: true, ir_led: true }, motion_detection: { enabled:true, sensitivity:true },
    image: {hflip:true,vflip:true,rotation:true},
    recording_schedule:{enabled:true,kinds:['continuous','motion']}, time_lapse:{configure:true,overwrite:true},
    spotlight: { manual:true, brightness:true, brightness_min:0, brightness_max:100 },
    ai_person: { sensitivity:true, delay_seconds:true }, ai_pet: { sensitivity:true, delay_seconds:true }
  } },
  ptz: { discovery: 'detected', supported:true, pan:true, tilt:true, presets:true, duration_ms:{min:50,max:3000}, speed_range:{min:1,max:64}, zoom_range:{min:0,max:27} }
};

const pngChunk = (name, data) => {
  const chunk = Buffer.alloc(12+data.length);
  chunk.writeUInt32BE(data.length);
  chunk.write(name,4);
  data.copy(chunk,8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4,-4)),chunk.length-4);
  return chunk;
};
export const png = () => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1,0); header.writeUInt32BE(1,4); header[8]=8; header[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(Buffer.from([0,3,8,30]))),pngChunk('IEND',Buffer.alloc(0))]);
};

const jpeg = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gARTGF2YzU4LjEzNC4xMDAA/9sAQwAIBAQEBAQFBQUFBQUGBgYGBgYGBgYGBgYGBwcHCAgIBwcHBgYHBwgICAgJCQkICAgICQkKCgoMDAsLDg4OEREU/8QATAABAQAAAAAAAAAAAAAAAAAAAAcBAQEAAAAAAAAAAAAAAAAAAAUHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAEAAQAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AjgC/i3//2Q==', 'base64');
const mediaFrame = Buffer.concat([
  Buffer.from('--reolink-frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + jpeg.length + '\r\n\r\n'),
  jpeg,
  Buffer.from('\r\n')
]);

export const fixtureBroker = async () => {
  const lease = tcp().listen(0, '127.0.0.1');
  await once(lease, 'listening');
  const port = lease.address().port;
  await new Promise(resolve => lease.close(resolve));
  const directory = await mkdtemp(join(tmpdir(), 'wui-bridge-mqtt-'));
  const config = join(directory, 'mosquitto.conf');
  await writeFile(config, 'listener ' + port + ' 127.0.0.1\nallow_anonymous true\npersistence false\n');
  const url = 'mqtt://127.0.0.1:' + port;
  const client = connect(url, { protocolVersion:5, connectTimeout:2000, reconnectPeriod:75 });
  client.on('error', () => {}); // The broker can be stopped deliberately by tests.
  let broker;
  const start = async () => {
    broker = spawn('mosquitto', ['-c', config], { stdio:'ignore' });
    const failed = new Promise((_, reject) => {
      broker.once('error', reject);
      broker.once('exit', code => reject(new Error('Mosquitto exited during startup (' + code + ')')));
    });
    await Promise.race([eventually(() => client.connected, 4000), failed]);
  };
  const stop = async () => {
    if (broker?.pid && broker.exitCode === null && broker.signalCode === null) {
      broker.kill();
      await once(broker, 'exit');
    }
  };
  const close = async () => {
    await client.endAsync(true);
    await stop();
    await rm(directory, { recursive:true, force:true });
  };
  try { await start(); }
  catch (error) { await close(); throw error; }
  return { client, url, start, stop, close };
};

export const fixtureBridge = async ({ previewCameras = [], capture = false, websocket = false, recordings = false, recordingCount = 1, metadataPages = false, previewNotifications = false, apiEvents = false, token = serviceToken, namePrefix = '', imageSettings = true, recordingSettings = true, manageAccounts = true, fixedCameras = [], enrollmentTargets } = {}) => {
  const previewRequests = [], recordingRequests = [];
  let previewJpeg = jpeg, previewRevision = 0;
  let led = false;
  let motion = true;
  let sensitivity = 40;
  let brightness = 5;
  const schedule = {enabled:true,schedules:{continuous:'0'.repeat(168),motion:'1'.repeat(168)}};
  const lapse = {enabled:false,configured:false,interval_seconds:10,format:'mp4',stream:'main',overwrite:false};
  const accountLists = new Map(), rotationStates = new Map();
  const accountsFor = (id) => {
    if (!accountLists.has(id)) accountLists.set(id, [
      {username:'admin',administrator:true,bridge_login:true,hidden:'redacted-fixture'},
      {username:'frontdesk',administrator:false,bridge_login:false}
    ]);
    return accountLists.get(id);
  };
  const orientation = {hflip:false,vflip:false,rotation:0};
  let inventory = ['alpha','beta'];
  let identities = {}, physical = {};
  let inventoryReads = 0;
  let playbackAvailable = true;
  let playbackFailure;
  let storageFailure;
  const ai = { ai_person:{sensitivity:76,delay_seconds:2}, ai_pet:{sensitivity:60,delay_seconds:0} };
  let lose = false;
  let writes = 0;
  let mediaOpened = 0;
  let mediaClosed = 0;
  const correlations = [];
  const requests = [];
  const callbacks = [];
  const controls = { ...caps.baichuan.controls };
  if (!imageSettings) delete controls.image;
  if (!recordingSettings) {
    delete controls.recording_schedule;
    delete controls.time_lapse;
  }
  const cameraCapabilities = camera => ({
    baichuan: { controls },
    ptz: fixedCameras.includes(camera) ? { discovery: 'unsupported', supported: false } : caps.ptz
  });
  const snapshots = () => inventory.flatMap(camera_id => [
    { camera_id, topic: 'info', payload: { baichuan: { name: namePrefix + (({ alpha:'Loading dock', beta:'Second camera' })[camera_id] ?? camera_id), model: 'Fixture model', vendor: { secret: token } } } },
    { camera_id, topic: 'capabilities', payload: cameraCapabilities(camera_id) },
    { camera_id, topic: 'availability', payload: { online: true, updated_at: new Date().toISOString() } },
    { camera_id, topic: 'state/settings', payload: {
      leds: { status_led: led, ir_mode: 'auto' }, motion_detection: { enabled: motion, sensitivity },
      spotlight: { brightness }, image:orientation, recording_schedule:schedule, time_lapse:lapse, ...ai
    } },
    { camera_id, topic: 'rules', payload: { baichuan: [{ id: 'rule-1', enabled:true, type:'motion', parameters:{password:token} }] } }
  ].map(item => identities[camera_id] ? { ...item, payload: { ...item.payload, stable_id: identities[camera_id] } } : item));
  const command = body => {
    const { id, command } = body;
    requests.push(command);
    if (command.setting === 'image_orientation') {
      if (command.action === 'hflip') orientation.hflip = !orientation.hflip;
      if (command.action === 'vflip') orientation.vflip = !orientation.vflip;
      if (command.action === 'clockwise') orientation.rotation = (orientation.rotation+90)%360;
      if (command.action === 'counterclockwise') orientation.rotation = (orientation.rotation+270)%360;
      writes++;
    }
    if (command.setting === 'status_led') { led = command.enabled; writes++; }
    if (command.setting === 'motion_detection') {
      motion = command.enabled ?? motion;
      sensitivity = command.sensitivity ?? sensitivity;
      writes++;
    }
    if (command.setting === 'ai_detection') {
      const fields = ai['ai_' + command.class];
      fields.sensitivity = command.sensitivity ?? fields.sensitivity;
      fields.delay_seconds = command.delay_seconds ?? fields.delay_seconds;
      writes++;
    }
    if (command.setting === 'recording_schedule') {
      if (command.enabled !== undefined) schedule.enabled = command.enabled;
      if (command.schedule) {
        const {kind,enable_hours,disable_hours} = command.schedule;
        const hours = [...schedule.schedules[kind]];
        for (const h of enable_hours) hours[h] = '1';
        for (const h of disable_hours) hours[h] = '0';
        schedule.schedules[kind] = hours.join('');
      }
      writes++;
    }
    if (command.setting === 'time_lapse') {
      const {setting, ...fields} = command;
      Object.assign(lapse, fields);
      if (fields.enabled) lapse.configured = true;
      writes++;
    }
    const state = {
      time_lapse:lapse, recording_schedule:schedule,
      image_orientation: orientation,
      motion_detection: { enabled:motion, sensitivity },
      ai_detection: ai['ai_' + command.class]
    }[command.setting] ?? { status_led:led, vendor:{ secret:token } };
    if (command.setting === 'ptz' && command.action.op === 'move') writes++;
    return {
      id, ok:true, correlation_id: uuid(), verified: command.action?.op !== 'move',
      state,
      result: { position: { pan: 12, tilt: 5, zoom: {position: 8} }, stopped: true, presets: [{id: 2, name:'Default'}] }
    };
  };
  const broker = await fixtureBroker();
  const baseTopic = 'fixture';
  if (capture) {
    const topic = baseTopic + '/alpha/command/exec';
    await broker.client.subscribeAsync(topic);
    broker.client.on('message', (received, payload) => {
      if (received !== topic) return;
      const { id, command } = JSON.parse(payload);
      if (command.setting !== 'snapshot') return;
      void broker.client.publishAsync(baseTopic + '/alpha/command/result', JSON.stringify({ id, ok:true, result:{
        content_type:'image/png', encoding:'base64', width:1, height:1, data_base64:png().toString('base64')
      } }));
    });
  }
  const publishSnapshots = () => Promise.all(snapshots().map(({ camera_id, topic, payload }) =>
    broker.client.publishAsync(baseTopic+'/'+camera_id+'/'+topic, JSON.stringify(payload), { qos:1, retain:true })
  ));
  await publishSnapshots();
  const read = async req => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks));
  };
  let recordedMp4;
  if (recordings) {
    const folder = await mkdtemp(join(tmpdir(),'wui-test-mp4-'));
    const file = join(folder,'recording.mp4');
    try {
      const encoder = spawn('ffmpeg',['-v','error','-f','lavfi','-i','color=blue:size=160x120:rate=16',
        '-t','2','-vf',"select='lt(t,1)+gte(t,1)*not(mod(n,2))'",'-vsync','vfr',
        '-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart',file],{stdio:'ignore'});
      assert.equal((await once(encoder,'exit'))[0],0);
      recordedMp4 = await readFile(file);
    } finally { await rm(folder,{recursive:true,force:true}); }
  }
  const apiSubscribers = new Map();
  let apiOpen = true;
  const server = createServer(async (req,res) => {
    if (req.url === '/livez') return res.end('{}');
    if (req.headers.authorization !== 'Bearer ' + token) { res.statusCode=401; return res.end('{}'); }
    if (apiEvents && new URL(req.url,'http://127.0.0.1').pathname === '/api/events') {
      if (!apiOpen) {res.statusCode=503;return res.end('{}');}
      const scope = new Set(new URL(req.url,'http://127.0.0.1').searchParams.get('cameras')?.split(',').filter(Boolean));
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('data: '+JSON.stringify({op:'ready',snapshots:snapshots().filter(item=>!scope.size||scope.has(item.camera_id))})+'\n\n');
      apiSubscribers.set(res,scope);
      const timer=setInterval(()=>res.write(': heartbeat\n\n'),8000);
      res.once('close',()=>{clearInterval(timer);apiSubscribers.delete(res);});
      return;
    }
    if (req.url.endsWith('/command/exec')) {
      correlations.push(req.headers['x-correlation-id']);
      const result = command(await read(req));
      if (lose) {
        lose = false;
        await broker.stop();
        return res.destroy();
      }
      return res.end(JSON.stringify(result));
    }
    if (req.url === '/api/enrollment-targets' && enrollmentTargets) return res.end(JSON.stringify({targets:enrollmentTargets}));
    if (req.url === '/api/contract') return res.end(JSON.stringify({
      version:1, userCameras:inventory, settings:['leds','spotlight','motion','ai',...(imageSettings?['image']:[]),...(recordingSettings?['recording_schedule','time_lapse']:[])], eventStream:apiEvents, media:true, mediaCameras:{alpha:['main','sub'], beta:['main']},
      previewNotifications, recordingMetadataCameras:recordings?['alpha','beta']:[], previewCameras, recordingPreviewCameras:recordings?['alpha','beta']:[], timeLapsePhotoCameras:recordings?['alpha','beta']:[], storageCameras:recordings?['alpha','beta']:[], recordingsCameras:recordings&&playbackAvailable?['alpha','beta']:[], enrollment:!!enrollmentTargets, inventory:true, callbacks:true
    }));
    if (req.url === '/api/inventory') {
      inventoryReads++;
      return res.end(JSON.stringify({ cameras:inventory.map(id => ({ id, stableId:identities[id], ...physical[id], active:true })) }));
    }
    if (/^\/api\/callbacks(?:\/[^/]+)?$/.test(req.url)) {
      const id = req.url.split('/')[3];
      if (req.method === 'POST') callbacks.push(await read(req));
      if (req.method === 'PUT') callbacks.splice(callbacks.findIndex(entry => entry.id === id), 1, await read(req));
      if (req.method === 'DELETE') callbacks.splice(callbacks.findIndex(entry => entry.id === id), 1);
      return res.end(JSON.stringify({ ok:true, correlation_id:req.headers['x-correlation-id'], callbacks }));
    }
    const cameraId = req.url.split('/')[3];
    if (req.url.endsWith('/rotation') && req.method === 'GET') return res.end(JSON.stringify({status:rotationStates.get(cameraId) ?? 'not-started'}));
    if (req.url.endsWith('/users') && req.method === 'GET') return res.end(JSON.stringify({writable:true,manageAccounts,requiresUid:true,users:accountsFor(cameraId)}));
    if (req.url.endsWith('/users') && req.method === 'POST') {
      const data = await read(req), users = accountsFor(cameraId);
      const index = users.findIndex(u=>u.username.toLowerCase() === data.username.toLowerCase());
      if (!manageAccounts || !data.confirmation || data.uid !== 'FIXTUREUID' ||
        (data.action === 'add' ? index >= 0 : index < 0 || users[index].bridge_login || data.action !== 'remove')) {
        res.statusCode=422; return res.end(JSON.stringify({errorKey:'API_CAMERA_ACCOUNT_REJECTED'}));
      }
      if (data.action === 'add') users.push({username:data.username,administrator:data.role==='administrator',bridge_login:false});
      else users.splice(index,1);
      writes++;
      return res.end(JSON.stringify({status:'verified',correlation_id:req.headers['x-correlation-id']}));
    }
    if (req.url.endsWith('/users/password') && req.method === 'POST') {
      const data = await read(req);
      if (data.uid !== 'FIXTUREUID' || !data.confirmation) { res.statusCode=422; return res.end('{}'); }
      writes++;
      if (data.username === 'admin') rotationStates.set(cameraId,'restart-required');
      return res.end(JSON.stringify({status:data.username === 'admin' ? 'restart-required' : 'verified', correlation_id:req.headers['x-correlation-id']}));
    }
    if (req.url.endsWith('/settings/recording_schedule')) return res.end(JSON.stringify({values:{recording_schedule:schedule}}));
    if (req.url.endsWith('/settings/time_lapse')) return res.end(JSON.stringify({values:{time_lapse:lapse}}));
    if (req.url.endsWith('/settings/image')) return res.end(JSON.stringify({values:{image:orientation}}));
    if (storageFailure && recordings && req.url.endsWith('/storage')) {
      res.writeHead(storageFailure.status, {'content-type':'application/json'});
      return res.end(JSON.stringify({errorKey:storageFailure.key, correlation_id:req.headers['x-correlation-id'], secret:token}));
    }
    const gallery=new URL(req.url,'http://127.0.0.1');
    if (recordings && gallery.pathname.endsWith('/time-lapse/photos')) {
      const q=gallery.searchParams;
      const photos=['09:15:00','12:45:00'].map((time,index)=>({time,id:String(index+1).repeat(64)}))
        .filter(photo=>q.get('date')==='2026-11-17' && photo.time >= (q.get('from')??'00:00:00') && photo.time <= (q.get('to')??'23:59:59'))
        .map(photo=>({id:photo.id,capturedAt:q.get('date')+'T'+photo.time}));
      return res.end(JSON.stringify({photos}));
    }
    if (recordings && /\/time-lapse\/photos\/(?:1{64}|2{64})$/.test(gallery.pathname)) {
      const data=png();
      res.writeHead(200,{'content-type':'image/png','content-length':data.length}); return res.end(data);
    }
    if (recordings && req.url.endsWith('/storage')) return res.end(JSON.stringify({
      cards:[{number:0,kind:'sd',mounted:true,formatted:true,totalBytes:64000000000,usedBytes:16000000000,freeBytes:48000000000}],
      playbackAvailable,cameraTime:'2026-11-17T12:30:00',refreshedAt:new Date().toISOString(),streams:['main','sub']
    }));
    if (recordings && /\/recordings\?/.test(req.url)) {
      const query = new URL(req.url,'http://127.0.0.1').searchParams;
      return res.end(JSON.stringify({
        date:query.get('date'),stream:query.get('stream'),truncated:false,
        recordings:Array.from({length:recordingCount},(_,index)=>({id:(index+10+(query.get('stream')==='main'?100:0)).toString(16).repeat(64).slice(0,64),start:query.get('date')+'T12:'+String(index).padStart(2,'0')+':00',end:query.get('date')+'T12:'+String(index).padStart(2,'0')+':02',stream:query.get('stream'),sizeBytes:recordedMp4.length,kind:'motion'}))
      }));
    }
    if (recordings && /\/recordings\/[a-f0-9]{64}\/preview(?:\?.*)?$/.test(req.url)) {
      recordingRequests.push({url:req.url,kind:'preview',at:performance.now()});
      if (req.url.endsWith('offsetMs=42000')) {
        res.writeHead(502,{'content-type':'application/json'});
        return res.end(JSON.stringify({errorKey:'API_MEDIA_START_FAILED'}));
      }
      res.writeHead(200,{'content-type':'image/jpeg'});
      return res.end(jpeg);
    }
    if (recordings && /\/recordings\/[a-f0-9]{64}\/metadata(?:\?.*)?$/.test(req.url)) {
      const frames = [
        {offsetMs:0,objects:[{class:'person',confidence:.92,bounding_box:{left:.1,top:.2,right:.4,bottom:.8,coordinate_space:'normalized_top_left',reference_frame:'fixture'}}]},
        {offsetMs:1000,objects:[]}
      ];
      const page = Number(new URL(req.url,'http://localhost').searchParams.get('page') ?? 0);
      return res.end(JSON.stringify({source:'recording',truncated:metadataPages && page===0,
        nextPage:metadataPages && page===0 ? 1 : null,frames:metadataPages ? [frames[page]] : frames}));
    }
    if (recordings && /\/recordings\/[a-f0-9]{64}\/video$/.test(req.url)) {
      recordingRequests.push({url:req.url,kind:'video',range:req.headers.range,at:performance.now()});
      if (playbackFailure) {
        res.writeHead(playbackFailure.status,{'content-type':'application/json'});
        return res.end(JSON.stringify({stage:playbackFailure.stage,correlation_id:playbackFailure.correlation,secret:token}));
      }
      let start=0,end=recordedMp4.length-1;
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range??'');
      if (range) {start=Number(range[1]); if(range[2]) end=Math.min(end,Number(range[2]));}
      if (start>=recordedMp4.length) {res.writeHead(416,{'content-range':'bytes */'+recordedMp4.length});return res.end();}
      res.writeHead(range?206:200,{
        'content-type':'video/mp4','content-length':end-start+1,'accept-ranges':'bytes',
        ...(range?{'content-range':'bytes '+start+'-'+end+'/'+recordedMp4.length}:{})
      });
      return res.end(recordedMp4.subarray(start,end+1));
    }
    if (req.url.endsWith('/settings/motion')) return res.end(JSON.stringify({ values:{ motion_detection:{enabled:motion,sensitivity} } }));
    if (req.url.endsWith('/settings/spotlight')) return res.end(JSON.stringify({ values:{ spotlight:{brightness} } }));
    const preview = /^\/api\/cameras\/([^/]+)\/preview(\?refresh=true)?$/.exec(req.url);
    if (preview && previewCameras.includes(preview[1])) {
      const etag = '"' + createHash('sha256').update(previewJpeg).digest('hex') + '"';
      const unchanged = req.headers['if-none-match'] === etag;
      previewRequests.push({ camera:preview[1], refresh:Boolean(preview[2]), unchanged, at:performance.now() });
      res.writeHead(unchanged ? 304 : 200, {
        etag, 'content-type':'image/jpeg', 'x-preview-captured-at':'2026-11-16T12:00:00.123Z'
      });
      return res.end(unchanged ? undefined : previewJpeg);
    }
    if (req.url.endsWith('/settings/ai')) return res.end(JSON.stringify({ values:ai }));
    if (req.url.endsWith('/settings/leds')) return res.end(JSON.stringify({ values:{ leds:{status_led:led,ir_mode:'auto'} } }));
    if (/\/media\/(main|sub)$/.test(req.url)) {
      mediaOpened++;
      res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=reolink-frame' });
      res.write(mediaFrame.subarray(0, 5));
      const first = globalThis.setTimeout(() => res.write(mediaFrame.subarray(5)), 20);
      const timer = setInterval(() => res.write(mediaFrame), 125);
      res.once('close', () => { mediaClosed++; clearTimeout(first); clearInterval(timer); });
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  let socketOpen = true;
  const wss = websocket ? new WebSocketServer({
    server, path:'/ws',
    verifyClient: ({ req }) => socketOpen && req.headers.authorization === 'Bearer ' + token
  }) : undefined;
  const subscribers = new Map();
  wss?.on('connection', socket => {
    socket.on('message', data => {
      const { id, op, cameras } = JSON.parse(data.toString());
      if (op === 'subscribe') subscribers.set(socket, new Set(cameras));
      const scope = subscribers.get(socket);
      socket.send(JSON.stringify({
        id, ok:true, snapshots:snapshots().filter(item => !scope?.size || scope.has(item.camera_id))
      }));
    });
    socket.on('close', () => subscribers.delete(socket));
  });
  const broadcast = (camera, message, transport) => {
    if (transport !== 'api') for (const [socket, scope] of subscribers) {
      if ((!scope.size || scope.has(camera)) && socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    }
    if (transport !== 'ws') for (const [response, scope] of apiSubscribers) {
      if (!scope.size || scope.has(camera)) response.write('data: '+JSON.stringify(message)+'\n\n');
    }
  };
  const publishEvent = (event, transport) => {
    if (transport !== 'mqtt') broadcast(event.camera_id, {op:'event',event},transport);
    if (transport !== 'ws' && transport !== 'api') broker.client.publish(baseTopic+'/'+event.camera_id+'/events', JSON.stringify(event));
  };
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const root = 'http://127.0.0.1:' + server.address().port;
  return {
    config: {
      id:'lab', label:'Fixture bridge', cameraIds:['alpha','beta'], commands:'http', events:'mqtt', ...(capture && {capture:'mqtt'}),
      http:{url:root,token:token}, mqtt:{url:broker.url,baseTopic}, callbacks:{fixture:root+'/callback'}
    },
    correlations, requests, previewRequests, recordingRequests,
    setPlaybackAvailable: value => { playbackAvailable = value; },
    setRecordingCount: value => { recordingCount = value; },
    setStorageFailure: value => { storageFailure = value; },
    setRecordingFailure: value => { playbackFailure = value; },
    setPreviewNotifications: value => { previewNotifications = value; },
    announcePreview: (camera_id='alpha', transport) => {
      const topic='state/preview', payload={preview:{etag:'"' + createHash('sha256').update(previewJpeg).digest('hex') + '"',captured_at:new Date().toISOString()}};
      if (transport !== 'mqtt') broadcast(camera_id,{op:'snapshot',snapshot:{camera_id,topic,payload}},transport);
      if (transport !== 'ws' && transport !== 'api') broker.client.publish(baseTopic+'/'+camera_id+'/'+topic,JSON.stringify(payload),{retain:true});
    },
    changePreview: () => {
      const comment = Buffer.from([0xff, 0xfe, 0, 3, ++previewRevision % 256]);
      previewJpeg = Buffer.concat([jpeg.subarray(0, 2), comment, jpeg.subarray(2)]);
    },
    counts: () => ({ writes, mediaOpened, mediaClosed, inventoryReads, callbacks:callbacks.length }),
    lose: () => { lose = true; },
    reportInventory: async (cameras, stableIds = {}, hardware = {}, publish = true) => {
      physical = hardware;
      inventory = cameras;
      identities = stableIds;
      if (publish) await publishSnapshots();
    },
    snapshot: async (camera_id, topic, payload) => {
      broadcast(camera_id, {op:'snapshot',snapshot:{camera_id,topic,payload}});
      await broker.client.publishAsync(baseTopic+'/'+camera_id+'/'+topic,JSON.stringify(payload),{qos:1,retain:true});
    },
    setReportedLevels: levels => { brightness = levels.brightness; sensitivity = levels.sensitivity; },
    disconnect: broker.stop,
    disconnectWs: () => { socketOpen = false; wss?.clients.forEach(socket => socket.terminate()); },
    reconnectWs: () => { socketOpen = true; },
    disconnectApi: () => { apiOpen = false; for (const response of apiSubscribers.keys()) response.destroy(); },
    reconnectApi: () => { apiOpen = true; },
    publishEvent,
    reconnect: async () => { await broker.start(); await publishSnapshots(); },
    detection: (camera, type, active) => {
      const topic = 'state/'+type;
      const payload = {active};
      broadcast(camera, {op:'snapshot',snapshot:{camera_id:camera,topic,payload}});
      broker.client.publish(baseTopic+'/'+camera+'/'+topic, JSON.stringify(payload), {retain:true});
    },
    event: (camera_id, type, details = {}, transport) => {
      const event = {camera_id,stable_id:identities[camera_id],type,active:true,received_at:new Date().toISOString(),source:'onvif',vendor:{password:token},...details};
      publishEvent(event,transport);
      return event;
    },
    close: async () => {
      wss?.clients.forEach(socket => socket.terminate());
      wss?.close();
      server.closeAllConnections();
      await Promise.all([broker.close(), new Promise(resolve => server.close(resolve))]);
    }
  };
};
