import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as tcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'mqtt';
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
  database = { driver: 'sqlite', path: ':memory:' }, sessionMinutes, localSessionMinutes
} = {}) => {
  const config = configSchema.parse({
    auth, database, publicOrigin, bridges, eventHistory, sessionMinutes, localSessionMinutes,
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
    spotlight: { manual:true, brightness:true, brightness_min:0, brightness_max:100 },
    ai_person: { sensitivity:true, delay_seconds:true }, ai_pet: { sensitivity:true, delay_seconds:true }
  } },
  ptz: { discovery: 'detected', supported:true, pan:true, tilt:true, presets:true, duration_ms:{min:50,max:3000}, speed_range:{min:1,max:64}, zoom_range:{min:0,max:27} }
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

export const fixtureBridge = async ({ previewCameras = [] } = {}) => {
  const previewRequests = [];
  let previewJpeg = jpeg;
  let led = false;
  let motion = true;
  let sensitivity = 40;
  let brightness = 5;
  let inventory = ['alpha','beta'];
  let inventoryReads = 0;
  const ai = { ai_person:{sensitivity:76,delay_seconds:2}, ai_pet:{sensitivity:60,delay_seconds:0} };
  let lose = false;
  let writes = 0;
  let mediaOpened = 0;
  let mediaClosed = 0;
  const correlations = [];
  const requests = [];
  const callbacks = [];
  const snapshots = () => inventory.flatMap(camera_id => [
    { camera_id, topic: 'info', payload: { baichuan: { name: ({ alpha:'Loading dock', beta:'Second camera' })[camera_id] ?? camera_id, model: 'Fixture model', vendor: { secret: serviceToken } } } },
    { camera_id, topic: 'capabilities', payload: caps },
    { camera_id, topic: 'availability', payload: { online: true, updated_at: new Date().toISOString() } },
    { camera_id, topic: 'state/settings', payload: {
      leds: { status_led: led, ir_mode: 'auto' }, motion_detection: { enabled: motion, sensitivity },
      spotlight: { brightness }, ...ai
    } },
    { camera_id, topic: 'rules', payload: { baichuan: [{ id: 'rule-1', enabled:true, type:'motion', parameters:{password:serviceToken} }] } }
  ]);
  const command = body => {
    const { id, command } = body;
    requests.push(command);
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
    const state = {
      motion_detection: { enabled:motion, sensitivity },
      ai_detection: ai['ai_' + command.class]
    }[command.setting] ?? { status_led:led, vendor:{ secret:serviceToken } };
    if (command.setting === 'ptz' && command.action.op === 'move') writes++;
    return {
      id, ok:true, correlation_id: uuid(), verified: command.action?.op !== 'move',
      state,
      result: { position: { pan: 12, tilt: 5, zoom: {position: 8} }, stopped: true, presets: [{id: 2, name:'Default'}] }
    };
  };
  const broker = await fixtureBroker();
  const baseTopic = 'fixture';
  const publishSnapshots = () => Promise.all(snapshots().map(({ camera_id, topic, payload }) =>
    broker.client.publishAsync(baseTopic+'/'+camera_id+'/'+topic, JSON.stringify(payload), { qos:1, retain:true })
  ));
  await publishSnapshots();
  const read = async req => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks));
  };
  const server = createServer(async (req,res) => {
    if (req.url === '/livez') return res.end('{}');
    if (req.headers.authorization !== 'Bearer ' + serviceToken) { res.statusCode=401; return res.end('{}'); }
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
    if (req.url === '/api/contract') return res.end(JSON.stringify({
      version:1, media:true, mediaCameras:{alpha:['main','sub'], beta:['main']},
      previewCameras, enrollment:false, inventory:true, callbacks:true
    }));
    if (req.url === '/api/inventory') {
      inventoryReads++;
      return res.end(JSON.stringify({ cameras:inventory.map(id => ({ id, active:true })) }));
    }
    if (/^\/api\/callbacks(?:\/[^/]+)?$/.test(req.url)) {
      const id = req.url.split('/')[3];
      if (req.method === 'POST') callbacks.push(await read(req));
      if (req.method === 'PUT') callbacks.splice(callbacks.findIndex(entry => entry.id === id), 1, await read(req));
      if (req.method === 'DELETE') callbacks.splice(callbacks.findIndex(entry => entry.id === id), 1);
      return res.end(JSON.stringify({ ok:true, correlation_id:req.headers['x-correlation-id'], callbacks }));
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
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const root = 'http://127.0.0.1:' + server.address().port;
  return {
    config: {
      id:'lab', label:'Fixture bridge', cameraIds:['alpha','beta'], commands:'http',
      http:{url:root,token:serviceToken}, mqtt:{url:broker.url,baseTopic}, callbacks:{fixture:root+'/callback'}
    },
    correlations, requests, previewRequests,
    changePreview: () => {
      const comment = Buffer.from([0xff, 0xfe, 0, 3, 1]);
      previewJpeg = Buffer.concat([jpeg.subarray(0, 2), comment, jpeg.subarray(2)]);
    },
    counts: () => ({ writes, mediaOpened, mediaClosed, inventoryReads }),
    lose: () => { lose = true; },
    reportInventory: async cameras => {
      inventory = cameras;
      await publishSnapshots();
    },
    setReportedLevels: levels => { brightness = levels.brightness; sensitivity = levels.sensitivity; },
    disconnect: broker.stop,
    reconnect: async () => { await broker.start(); await publishSnapshots(); },
    detection: (camera, type, active) => broker.client.publish(
      baseTopic+'/'+camera+'/state/'+type, JSON.stringify({active}), { retain:true }
    ),
    event: (camera_id, type, details = {}) => broker.client.publish(
      baseTopic+'/'+camera_id+'/events',
      JSON.stringify({ camera_id, type, active:true, received_at:new Date().toISOString(), source:'onvif', vendor:{password:serviceToken}, ...details })
    ),
    close: async () => {
      server.closeAllConnections();
      await Promise.all([broker.close(), new Promise(resolve => server.close(resolve))]);
    }
  };
};
