import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { once } from 'node:events';
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
  Buffer.from('--wui\r\nContent-Type: image/jpeg\r\nContent-Length: ' + jpeg.length + '\r\n\r\n'),
  jpeg,
  Buffer.from('\r\n')
]);

export const fixtureBridge = async ({ previewCameras = [] } = {}) => {
  const previewRequests = [];
  let previewJpeg = jpeg;
  let led = false;
  let motion = true;
  let sensitivity = 40;
  let brightness = 5;
  let inventory;
  let inventoryReads = 0;
  const ai = { ai_person:{sensitivity:76,delay_seconds:2}, ai_pet:{sensitivity:60,delay_seconds:0} };
  let lose = false;
  let writes = 0;
  let mediaOpened = 0;
  let mediaClosed = 0;
  const correlations = [];
  const requests = [];
  const callbacks = [];
  const snapshots = () => ['alpha', 'beta'].flatMap(camera_id => [
    { camera_id, topic: 'info', payload: { baichuan: { name: camera_id === 'alpha' ? 'Loading dock' : 'Second camera', model: 'Fixture model', vendor: { secret: serviceToken } } } },
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
  const server = createServer(async (req,res) => {
    if (req.url === '/livez') return res.end('{}');
    if (req.headers.authorization !== 'Bearer ' + serviceToken) { res.statusCode=401; return res.end('{}'); }
    if (req.url.endsWith('/command/exec')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      correlations.push(req.headers['x-correlation-id']);
      return res.end(JSON.stringify(command(JSON.parse(Buffer.concat(chunks)))));
    }
    if (req.url.endsWith('/contract')) return res.end(JSON.stringify({
      version:1, media:true, mediaCameras:{alpha:['main','sub'], beta:['main']}, previewCameras, enrollment:false, inventory:!!inventory
    }));
    if (req.url.endsWith('/inventory')) {
      inventoryReads++;
      return res.end(JSON.stringify({ cameras:(inventory ?? []).map(id => ({ id })) }));
    }
    if (req.url.endsWith('/settings/motion')) return res.end(JSON.stringify({ values:{ motion_detection:{enabled:motion,sensitivity} } }));
    if (req.url.endsWith('/settings/spotlight')) return res.end(JSON.stringify({ values:{ spotlight:{brightness} } }));
    const preview = /^\/api\/wui\/v1\/cameras\/([^/]+)\/preview(\?refresh=true)?$/.exec(req.url);
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
      res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=wui' });
      res.write(mediaFrame);
      const timer = setInterval(() => res.write(mediaFrame), 125);
      res.once('close', () => { mediaClosed++; clearInterval(timer); });
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket, req) => {
    if (req.headers.authorization !== 'Bearer ' + serviceToken) { socket.close(); return; }
    socket.on('message', data => {
      const body = JSON.parse(data.toString());
      const { id } = body;
      if (body.op === 'subscribe' || body.op === 'snapshot') {
        socket.send(JSON.stringify({ id, ok:true, snapshots:snapshots().filter(item => !body.cameras?.length || body.cameras.includes(item.camera_id)) }));
      } else if (body.op === 'control') {
        const result = command(body);
        if (lose) { lose = false; socket.terminate(); }
        else socket.send(JSON.stringify(result));
      } else if (body.op.startsWith('callbacks_')) {
        if (body.op === 'callbacks_add') callbacks.push(body.callback);
        if (body.op === 'callbacks_update') callbacks.splice(callbacks.findIndex(entry => entry.id===body.callback.id),1,body.callback);
        if (body.op === 'callbacks_remove') callbacks.splice(callbacks.findIndex(entry => entry.id===body.callback_id),1);
        socket.send(JSON.stringify({ id, ok:true, correlation_id:uuid(), callbacks }));
      }
    });
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const root = 'http://127.0.0.1:' + server.address().port;
  return {
    config: {
      id:'lab', label:'Fixture bridge', cameraIds:['alpha','beta'], commands:'http', events:'ws',
      http:{url:root,token:serviceToken}, ws:{url:root.replace('http:', 'ws:')+'/ws',token:serviceToken},
      extensions:{url:root,token:serviceToken,relay:true}, callbacks:{fixture:root+'/callback'}
    },
    correlations, requests, previewRequests,
    changePreview: () => {
      const comment = Buffer.from([0xff, 0xfe, 0, 3, 1]);
      previewJpeg = Buffer.concat([jpeg.subarray(0, 2), comment, jpeg.subarray(2)]);
    },
    counts: () => ({ writes, mediaOpened, mediaClosed, inventoryReads }),
    lose: () => { lose = true; },
    reportInventory: cameras => { inventory = cameras; },
    setReportedLevels: levels => { brightness = levels.brightness; sensitivity = levels.sensitivity; },
    detection: (camera_id, type, active) => wss.clients.forEach(socket => socket.send(JSON.stringify({
      op:'snapshot', snapshot:{camera_id, topic:'state/'+type, payload:{active}}
    }))),
    event: (camera_id, type, details = {}) => wss.clients.forEach(socket => socket.send(JSON.stringify({
      op:'event', event:{ camera_id, type, active:true, received_at:new Date().toISOString(), source:'onvif', vendor:{password:serviceToken}, ...details }
    }))),
    close: () => new Promise(resolve => {
      wss.clients.forEach(socket => socket.terminate());
      wss.close();
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
};
