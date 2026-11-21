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
  ptz: { discovery: 'detected', supported:true, pan:true, tilt:true, presets:true, save_presets:true, delete_presets:true, duration_ms:{min:50,max:3000}, speed_range:{min:1,max:64}, zoom_range:{min:0,max:27} }
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

export const jpeg = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gARTGF2YzU4LjEzNC4xMDAA/9sAQwAIBAQEBAQFBQUFBQUGBgYGBgYGBgYGBgYGBwcHCAgIBwcHBgYHBwgICAgJCQkICAgICQkKCgoMDAsLDg4OEREU/8QATAABAQAAAAAAAAAAAAAAAAAAAAcBAQEAAAAAAAAAAAAAAAAAAAUHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAEAAQAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AjgC/i3//2Q==', 'base64');
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

export const fixtureBridge = async ({ previewCameras = [], capture = false, websocket = false, recordings = false, recordingCount = 1, metadataPages = false, previewNotifications = false, apiEvents = false, token = serviceToken, namePrefix = '', imageSettings = true, recordingSettings = true, manageAccounts = true, fixedCameras = [], enrollmentTargets, enrollmentAddress, terminate = true, terminationOptions = terminate } = {}) => {
  const previewRequests = [], recordingRequests = [];
  let previewJpeg = jpeg, previewRevision = 0;
  let led = false;
  let motion = true;
  let sensitivity = 40;
  const presets = new Map([[2,'Default']]);
  let presetPan = 12;
  const presetPans = new Map([[2,22]]);
  let brightness = 5;
  const schedule = {enabled:true,schedules:{continuous:'0'.repeat(168),motion:'1'.repeat(168)}};
  const lapse = {enabled:false,configured:false,interval_seconds:10,format:'mp4',stream:'main',overwrite:false};
  const networks = new Map();
  const displays = new Map();
  let displayRejection, lapseRejection, encoderReadFailures=0, ftpReadFailures=0;
  let photoExpired = false;
  const encoders = new Map();
  const deviceOptions = new Map(), privacyAreas = new Map();
  const speakers = new Map();
  const talkStats = { starts:0, chunks:0, stops:0 };
  let legacyClock=false;
  const clocks = new Map(), radios = new Map();
  let delayNextPreset = false;
  const rtspSwitches = new Map();
  const accountLists = new Map(), rotationStates = new Map();
  const enrolled = new Set();
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
  let mediaStartGate;
  let playbackFailure;
  let storageFailure;
  const ai = { ai_person:{sensitivity:76,delay_seconds:2}, ai_pet:{sensitivity:60,delay_seconds:0} };
  let lose = false;
  let ptzFailure;
  let writes = 0;
  let mediaOpened = 0;
  let mediaClosed = 0;
  const correlations = [];
  const requests = [];
  const terminations = [];
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
      if (lapseRejection) {
        const cameraStatus = lapseRejection;
        lapseRejection = undefined;
        return {id,ok:false,correlation_id:uuid(),errorKey:'CONTROL_TIME_LAPSE_REJECTED',cameraStatus};
      }
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
    if (command.setting === 'ptz' && command.action.op === 'move') {
      writes++;
      if (ptzFailure) {
        const errorKey = ptzFailure; ptzFailure = undefined;
        return {id,ok:false,correlation_id:uuid(),errorKey};
      }
    }
    if (command.setting === 'ptz' && command.action.op === 'delete_preset') {
      presets.delete(command.action.preset_id);
      presetPans.delete(command.action.preset_id);
      writes++;
    }
    if (command.setting === 'ptz' && command.action.op === 'save_preset') {
      const {preset_id,name,replace} = command.action;
      if (presets.has(preset_id) && !replace) return {id,ok:false,errorKey:'PTZ_PRESET_OCCUPIED'};
      if (delayNextPreset) {
        delayNextPreset = false;
        void setTimeout(400).then(()=>presets.set(preset_id,name));
        presetPans.set(preset_id,presetPan);
        writes++;
        return {id,ok:true,verified:false,result:{presets:Array.from(presets,([id,name])=>({id,name}))}};
      }
      presets.set(preset_id,name);
      presetPans.set(preset_id,presetPan);
      writes++;
    }
    if (command.setting === 'ptz' && command.action.op === 'goto_preset') presetPan = presetPans.get(command.action.preset_id) ?? presetPan;
    return {
      id, ok:true, correlation_id: uuid(), verified: command.action?.op !== 'move' && command.action?.op !== 'goto_preset',
      state,
      result: { position: { pan: presetPan, tilt: 5, zoom: {position: 8} }, stopped: true, presets: Array.from(presets,([id,name]) => ({id,name})) }
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
    if (req.url === '/api/enrollment-targets' && enrollmentTargets) return res.end(JSON.stringify({targets:enrollmentTargets,addressLookup:!!enrollmentAddress,enableRtsp:true}));
    if (enrollmentAddress && req.url.startsWith('/api/enrollment-targets/identify?')) {
      const query = new URL(req.url,'http://127.0.0.1').searchParams;
      if (query.get('address') !== enrollmentAddress || (query.has('port') && query.get('port') !== '9000')) {
        res.statusCode = 404;
        return res.end(JSON.stringify({errorKey:'API_ENROLLMENT_ADDRESS_UNKNOWN'}));
      }
      return res.end(JSON.stringify({target:'alpha',address:enrollmentAddress,port:9000,uid:'TESTWUI001',model:'E1 Pro',serial:'FIXTURE-E1',privateField:'bridge-only-fixture'}));
    }
    if (enrollmentAddress && req.url === '/api/enrollments' && req.method === 'POST') {
      const intent = await read(req);
      if (intent.target !== 'alpha' || intent.address !== enrollmentAddress || intent.port !== 9000 || intent.method !== 'initialize'
          || intent.uid !== 'TESTWUI001' || intent.serial !== 'FIXTURE-E1' || intent.confirmation !== true) {
        res.statusCode = 422;
        return res.end(JSON.stringify({errorKey:'API_ENROLLMENT_INVALID'}));
      }
      enrolled.add(intent.id);
      if (intent.enableRtsp) rtspSwitches.set('alpha',true);
      return res.end(JSON.stringify({status:'active',camera_id:'alpha',rtsp:intent.enableRtsp?'enabled':null}));
    }
    if (req.method === 'GET' && req.url.startsWith('/api/enrollments/') && enrolled.has(req.url.split('/').at(-1))) {
      return res.end(JSON.stringify({status:'active',camera_id:'alpha'}));
    }
    if (terminate && req.url === '/api/terminate' && req.method === 'POST') {
      const body = await read(req);
      terminations.push(body);
      res.statusCode = 202;
      return res.end(JSON.stringify({ok:true,status:'terminating',exitCode:body.exitCode,correlation_id:req.headers['x-correlation-id']}));
    }
    if (req.url === '/api/contract') return res.end(JSON.stringify({
      version:1, terminate, terminationOptions, talk:true, detectionZones:imageSettings, privacyMaskEditing:imageSettings, ftpDestination:imageSettings, deviceOptions:imageSettings, displayCameras:inventory, encodingCameras:inventory, clockCameras:inventory, rtspSettings:true, networkCameras:inventory, userCameras:inventory, settings:['leds','spotlight','motion','ai',...(imageSettings?['image']:[]),...(recordingSettings?['recording_schedule','time_lapse']:[])], eventStream:apiEvents, media:true, mediaCameras:{alpha:['main','sub','third'], beta:['main']},
      mediaFileCameras:inventory, previewNotifications, recordingMetadataCameras:recordings?['alpha','beta']:[], previewCameras, recordingPreviewCameras:recordings?['alpha','beta']:[], timeLapsePhotoCameras:recordings?['alpha','beta']:[], storageCameras:recordings?['alpha','beta']:[], recordingsCameras:recordings&&playbackAvailable?['alpha','beta']:[], enrollment:!!enrollmentTargets, inventory:true, callbacks:true
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
    const talk=req.url.match(/^\/api\/cameras\/[^/]+\/talk(?:\/([0-9a-f-]+))?$/);
    if(talk){
      const format={available:true,sampleRate:16000,blockSamples:1025};
      const owner=talk[1], current=speakers.get(cameraId);
      if(req.method==='GET')return res.end(JSON.stringify(format));
      if(req.method==='POST'){
        if(current && current.owner!==owner){res.statusCode=409;return res.end(JSON.stringify({errorKey:'API_TALK_BUSY'}));}
        if(!current){speakers.set(cameraId,{owner,next:0});talkStats.starts++;}
        return res.end(JSON.stringify(format));
      }
      if(req.method==='PUT'){
        if(current?.owner!==owner){res.statusCode=404;return res.end(JSON.stringify({errorKey:'API_TALK_EXPIRED'}));}
        const {pcm,sequence}=await read(req);
        if(sequence>current.next || !pcm || Buffer.from(pcm,'base64').length%2050!==0){
          res.statusCode=400;return res.end(JSON.stringify({errorKey:'API_TALK_INVALID'}));
        }
        if(sequence===current.next){talkStats.chunks++;current.next++;}
      }
      if(req.method==='DELETE' && current?.owner===owner){speakers.delete(cameraId);talkStats.stops++;}
      res.statusCode=204;return res.end();
    }
    if (req.url.endsWith('/rotation') && req.method === 'GET') return res.end(JSON.stringify({status:rotationStates.get(cameraId) ?? 'not-started'}));
    if (req.url.startsWith('/api/cameras/'+cameraId+'/options/')) {
      const group=req.url.split('/').at(-1);
      if(['motionZone','personZone','petZone','vehicleZone','faceZone'].includes(group)){
        if(!imageSettings || !['motionZone','personZone'].includes(group)){
          res.statusCode=422;return res.end(JSON.stringify({errorKey:'API_DEVICE_OPTIONS_UNSUPPORTED'}));
        }
        const width=8,height=4;
        let cells=deviceOptions.get(req.url)??'1'.repeat(width*height);
        const revision=()=>createHash('sha256').update(group+cells).digest('hex');
        if(req.method==='PUT'){
          const {fields}=await read(req);
          if(fields.expectedRevision!==revision()){res.statusCode=409;return res.end(JSON.stringify({errorKey:'API_DETECTION_ZONE_CHANGED'}));}
          cells=fields.cells;deviceOptions.set(req.url,cells);
        }
        return res.end(JSON.stringify({fields:{},zone:{cells,width,height,revision:revision()},outcome:'confirmed',correlation_id:req.headers['x-correlation-id']}));
      }
      if(group==='ftpDestination'){
        if(req.method==='GET' && ftpReadFailures>0){ftpReadFailures--;res.statusCode=502;return res.end(JSON.stringify({errorKey:'API_DEVICE_OPTIONS_READ_FAILED'}));}
        if(cameraId!=='alpha'){res.statusCode=422;return res.end(JSON.stringify({errorKey:'API_DEVICE_OPTIONS_UNSUPPORTED'}));}
        const fields=deviceOptions.get(req.url) ?? {server:'',port:21,username:'',remoteDirectory:'',anonymous:false,ftpsOnly:false,password:''};
        if(req.method==='PUT'){
          const change=(await read(req)).fields;
          if(fields.password && !Object.hasOwn(change,'password') && ['server','port'].some(key=>Object.hasOwn(change,key) && change[key]!==fields[key])){
            res.statusCode=422;return res.end(JSON.stringify({errorKey:'API_DEVICE_OPTIONS_INVALID'}));
          }
          Object.assign(fields,change);deviceOptions.set(req.url,fields);
        }
        // Include a spurious private field to verify that the WUI's own projection strips it.
        return res.end(JSON.stringify({fields,password:fields.password,passwordStored:!!fields.password,passwordMaxLength:127,
          ...(req.method==='PUT' && {outcome:'confirmed',correlation_id:req.headers['x-correlation-id']})}));
      }
      const defaults={
        picture:{brightness:{value:128,min:0,max:255},contrast:{value:120,min:0,max:255},dayNight:{value:'auto',choices:['auto','color','blackAndWhite']}},
        threshold:{switchThreshold:{value:45,min:0,max:255}},
        sound:{speakerVolume:{value:70,min:0,max:100}}, recordingAudio:{mainAudio:{value:true},subAudio:{value:true},thirdAudio:{value:false}},
        privacy:{maskEnabled:{value:false}}, tracking:{autoTracking:{value:false}}, siren:{sirenOnEvent:{value:false}},
        push:{pushEnabled:{value:false}},email:{emailEnabled:{value:false}},ftp:{ftpEnabled:{value:false}}
      };
      const fields=deviceOptions.get(req.url) ?? defaults[group];
      if(!fields){res.statusCode=422;return res.end(JSON.stringify({errorKey:'API_DEVICE_OPTIONS_UNSUPPORTED'}));}
      if(group==='privacy'){
        const areas=privacyAreas.get(cameraId)??[];
        const revision=()=>createHash('sha256').update(JSON.stringify([fields.maskEnabled.value,areas])).digest('hex');
        if(req.method==='PUT'){
          const {fields:changes}=await read(req);
          if(changes.maskAreas){
            if(changes.expectedRevision!==revision()){res.statusCode=409;return res.end(JSON.stringify({errorKey:'API_PRIVACY_MASKS_CHANGED'}));}
            areas.splice(0,areas.length,...changes.maskAreas);
          }
          if(changes.maskEnabled && !areas.length){res.statusCode=422;return res.end(JSON.stringify({errorKey:'API_DEVICE_OPTIONS_INVALID'}));}
          fields.maskEnabled.value=changes.maskEnabled;privacyAreas.set(cameraId,areas);deviceOptions.set(req.url,fields);
        }
        return res.end(JSON.stringify({fields,privacyZones:areas.length,privacyMasks:{areas,maxAreas:4,revision:revision()},
          ...(req.method==='PUT' && {outcome:'confirmed',correlation_id:req.headers['x-correlation-id']})}));
      }
      const view={fields};
      if(req.method==='PUT'){
        const {fields:changes}=await read(req);
        if(Object.entries(changes).some(([key,value])=>!fields[key] || group==='privacy' && value)){
          res.statusCode=422;return res.end(JSON.stringify({errorKey:'API_DEVICE_OPTIONS_INVALID'}));
        }
        for(const [key,value] of Object.entries(changes))fields[key].value=value;
        deviceOptions.set(req.url,fields);
        return res.end(JSON.stringify({...view,outcome:'confirmed',correlation_id:req.headers['x-correlation-id']}));
      }
      return res.end(JSON.stringify(view));
    }
    if (req.url.endsWith('/display')) {
      const fields = displays.get(cameraId) ?? {deviceName:'Fixture camera',dateFormat:'DMY',name:'Camera1',nameVisible:true,
        nameX:65536,nameY:65536,timeVisible:true,timeX:65536,timeY:1,watermark:true,background:false};
      if (req.method === 'PUT') {
        const change = (await read(req)).fields;
        if (displayRejection) {
          const rejection = displayRejection;
          displayRejection = undefined;
          res.statusCode = 422;
          return res.end(JSON.stringify({errorKey:'API_DISPLAY_REJECTED',correlation_id:req.headers['x-correlation-id'],...rejection}));
        }
        Object.assign(fields,change); displays.set(cameraId,fields);
        return res.end(JSON.stringify({outcome:'confirmed',fields,correlation_id:req.headers['x-correlation-id']}));
      }
      return res.end(JSON.stringify({fields}));
    }
    if (req.url.endsWith('/encoding')) {
      if(req.method==='GET' && encoderReadFailures>0){
        encoderReadFailures--;
        res.statusCode=502;
        return res.end(JSON.stringify({errorKey:'API_ENCODING_READ_FAILED',correlation_id:req.headers['x-correlation-id']}));
      }
      const profiles = encoders.get(cameraId) ?? [
        {stream:'main',current:{width:2560,height:1440,fps:20,bitrate:4096,gop:2},gopRange:[1,2],options:[
          {width:2560,height:1440,fps:[20,25,15],bitrates:[2048,3072,4096]},
          {width:1920,height:1080,fps:[15,10],bitrates:[2048,3072]}]},
        {stream:'sub',current:{width:640,height:360,fps:4,bitrate:128},options:[{width:640,height:360,fps:[10,4],bitrates:[128,256]}]},
        {stream:'third',current:{width:896,height:512,fps:15,bitrate:1228},options:[]}
      ];
      if(req.method==='PUT'){
        const {stream,settings}=await read(req); const p=profiles.find(p=>p.stream===stream);
        if(!p || settings.fps===999){res.statusCode=422;return res.end(JSON.stringify({errorKey:'API_ENCODING_INVALID'}));}
        p.current={...p.current,...settings};encoders.set(cameraId,profiles);
        return res.end(JSON.stringify({outcome:'confirmed',profiles,correlation_id:req.headers['x-correlation-id']}));
      }
      return res.end(JSON.stringify({profiles}));
    }
    if (req.url.endsWith('/clock')) {
      const current=clocks.get(cameraId) ?? {cameraTime:'2026-11-19T07:05:02',settings:{utcOffsetMinutes:-480,daylightSavingEnabled:false,ntpEnabled:false}};
      const output=reading=>({cameraTime:reading.cameraTime,...(legacyClock!==true && {settings:reading.settings}),
        ...(!legacyClock && {editableOptions:['daylightSavingEnabled','ntpEnabled']})});
      if (req.method==='PUT') {
        const {cameraTime,timeZone,daylightSavingEnabled,ntpEnabled}=await read(req);
        if(cameraTime!==undefined && !timeZone && (ntpEnabled ?? current.settings.ntpEnabled) && cameraTime!==current.cameraTime) {
          res.statusCode=422;return res.end(JSON.stringify({errorKey:'API_CLOCK_NTP_ACTIVE'}));
        }
        const settings={utcOffsetMinutes:timeZone?.utcOffsetMinutes ?? current.settings.utcOffsetMinutes,
          daylightSavingEnabled:timeZone?Boolean(timeZone.daylightSaving):daylightSavingEnabled ?? current.settings.daylightSavingEnabled,
          ntpEnabled:ntpEnabled ?? current.settings.ntpEnabled};
        const saved={cameraTime:cameraTime ?? current.cameraTime,settings};
        clocks.set(cameraId,saved);
        return res.end(JSON.stringify({outcome:'confirmed',...output(saved)}));
      }
      return res.end(JSON.stringify(output(current)));
    }
    if (req.url.endsWith('/network/wifi') && req.method==='PUT') {
      const {enabled,confirmation}=await read(req);
      if (!confirmation || cameraId!=='alpha') {res.statusCode=409;return res.end(JSON.stringify({errorKey:'API_NETWORK_WIRED_REQUIRED'}));}
      radios.set(cameraId,enabled);
      return res.end(JSON.stringify({outcome:'confirmed',enabled}));
    }
    if (req.url.endsWith('/network/rtsp')) {
      if (req.method === 'PUT') {
        const {enabled} = await read(req);
        rtspSwitches.set(cameraId,enabled);
        return res.end(JSON.stringify({outcome:'confirmed',enabled,port:8554}));
      }
      return res.end(JSON.stringify({supported:true,enabled:rtspSwitches.get(cameraId) ?? false,port:8554}));
    }
    if (req.url.endsWith('/network')) {
      if (req.method === 'GET') return res.end(JSON.stringify({
        interfaces:{ethernet:cameraId==='alpha'?{addresses:['192.0.2.3'],active:true,enabled:true,dhcp:true}:null,
          wifi:{addresses:['192.0.2.4'],active:cameraId!=='alpha',enabled:radios.get(cameraId) ?? true,dhcp:true}},
        wifiSignal:-47,wifiSwitchAvailable:cameraId==='alpha',
        wifi:{ssid:networks.get(cameraId) ?? 'Fixture LAN',nearby:['Fixture LAN','Office wireless'],configurable:true,key:'should-never-leave-the-bridge'},
        link:{address:'192.0.2.3',gateway:'192.0.2.1',netmask:'255.255.255.0',dhcp:true}
      }));
      if (req.method === 'PUT') {
        const change = await read(req);
        if (change.ssid === 'Disconnect') {res.statusCode=502; return res.end(JSON.stringify({errorKey:'API_NETWORK_OUTCOME_UNKNOWN'}));}
        networks.set(cameraId, change.ssid);
        return res.end(JSON.stringify({outcome:change.ssid==='Masked firmware'?'unverified':'confirmed',ssidVerified:true}));
      }
    }
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
    if (req.url.endsWith('/media/capabilities')) {
      return res.end(JSON.stringify({source:(cameraId==='alpha'?'a':'b').repeat(64),video:cameraId==='alpha',timeLapse:true,cameraTime:'2026-11-20T12:00:00'}));
    }
    if (req.url.includes('/media/days?')) return res.end(JSON.stringify({days:[]}));
    const gallery=new URL(req.url,'http://127.0.0.1');
    if (recordings && gallery.pathname.endsWith('/time-lapse/photos')) {
      const q=gallery.searchParams;
      if (q.get('date')==='2026-11-18') {
        const time='10:30:00';
        const present=time >= (q.get('from')??'00:00:00') && time <= (q.get('to')??'23:59:59');
        return res.end(JSON.stringify({photos:present?[{id:'3'.repeat(64),capturedAt:null}]:[]}));
      }
      const photos=['09:15:00','12:45:00'].map((time,index)=>({time,id:String(index+1).repeat(64)}))
        .filter(photo=>q.get('date')==='2026-11-17' && photo.time >= (q.get('from')??'00:00:00') && photo.time <= (q.get('to')??'23:59:59'))
        .map(photo=>({id:photo.id,capturedAt:q.get('date')+'T'+photo.time}));
      return res.end(JSON.stringify({photos}));
    }
    if (recordings && /\/time-lapse\/photos\/(?:1{64}|2{64}|3{64})$/.test(gallery.pathname)) {
      if (gallery.searchParams.get('preview') === 'true') {
        if (photoExpired) {photoExpired=false;res.statusCode=404;return res.end('{}');}
        if (gallery.pathname.endsWith('1'.repeat(64))) {
          res.writeHead(200,{'content-type':'image/jpeg','content-length':jpeg.length});return res.end(jpeg);
        }
      }
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
    if (/\/media\/(main|sub|third)$/.test(req.url)) {
      mediaOpened++;
      if (mediaStartGate) await mediaStartGate;
      if (res.destroyed) return;
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
    correlations, requests, terminations, previewRequests, recordingRequests,
    holdMediaUntil: gate => { mediaStartGate = gate; },
    delayNextPreset: () => {delayNextPreset = true;},
    setPresetList: entries => { presets.clear(); for (const [id,name] of entries) presets.set(id,name); },
    setPlaybackAvailable: value => { playbackAvailable = value; },
    expireNextPhoto: () => {photoExpired=true;},
    setRecordingCount: value => { recordingCount = value; },
    setLegacyClock: value => { legacyClock=value; },
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
    failNextPtzMove: key => { ptzFailure = key; },
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
    talkStats,
    failFtpReads: count => {ftpReadFailures=count;},
    failEncoderReads: count => { encoderReadFailures=count; },
    rejectNextDisplay: cameraStatus => { displayRejection = {cameraStatus}; },
    rejectNextTimeLapse: status => { lapseRejection = status; },
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
