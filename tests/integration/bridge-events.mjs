import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectAsync } from 'mqtt';
import { eventually, launch, publicOrigin, uuid } from '../support.mjs';

// The bridge E2E runner supplies its loopback camera, broker and callback receiver.
const { FIXTURE_BRIDGE, FIXTURE_TOKEN, FIXTURE_BROKER, FIXTURE_INGRESS, FIXTURE_RECEIVER } = process.env;

async function nextBrowserEvent(url, headers, trigger) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  let pending = '';
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    pending += chunk;
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) !== -1) {
      const data = pending.slice(0, boundary).split('\n').find(line => line.startsWith('data: '));
      pending = pending.slice(boundary + 2);
      if (!data) continue;
      const frame = JSON.parse(data.slice(6));
      if (frame.kind === 'connected') await trigger();
      if (frame.kind === 'event') return frame;
    }
  }
  assert.fail('Browser event stream ended before the camera event');
}

test('real bridge routes WUI callbacks, MQTT commands and all three event sources', { timeout: 60_000 }, async t => {
  const sources = ['ws', 'mqtt', 'api'];
  const { app, seed, signIn } = await launch({ bridges: [{
    id: 'fixture', label: 'Fixture bridge', cameraIds: ['lab'], events: sources, commands: 'mqtt',
    http: { url: FIXTURE_BRIDGE, token: FIXTURE_TOKEN },
    mqtt: { url: FIXTURE_BROKER, baseTopic: 'site/cameras' },
    callbacks: { receiver: FIXTURE_RECEIVER }
  }] });
  t.after(() => app.close());
  const base = await app.listen({ host: '127.0.0.1', port: 0 }) + '/api/v1';
  await seed({ username: 'fixture-owner', admin: true });
  const headers = { ...await signIn('fixture-owner'), origin: publicOrigin };
  async function request(path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method, headers: { ...headers, ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body), signal: AbortSignal.timeout(12_000)
    });
    const value = await response.json();
    assert.equal(response.status, 200, method + ' ' + path + ': ' + JSON.stringify(value));
    return value;
  }

  const observer = await connectAsync(FIXTURE_BROKER, { protocolVersion: 5, reconnectPeriod: 0 });
  t.after(() => observer.endAsync(true));
  const packets = [];
  const topic = 'site/cameras/lab/';
  observer.on('message', (name, payload) => packets.push({ name, body: JSON.parse(payload) }));
  await observer.subscribeAsync([topic + 'events', topic + 'command/exec', topic + 'command/result'], { qos: 1 });

  const camera = await eventually(async () => (await request('/cameras')).cameras.find(item => item.deviceUid === '952700FIXTURE0001'));
  const admin = '/admin/bridges/fixture';
  const callbackId = 'wui-notify';
  const list = () => request(admin + '/callbacks');
  assert.deepEqual((await list()).destinations, ['receiver']);
  const expectedDeliveries = [];

  for (const [source, action, reason, type] of [
    ['ws', 'add', 'doorbell', 'doorbell'],
    ['mqtt', 'update', 'pir', 'motion'],
    ['api', 'remove', 'pir', 'motion']
  ]) {
    const priority = [source, ...sources.filter(other => other !== source)];
    const changed = await request(admin + '/event-sources', 'PUT', { operationId: uuid(), sources: priority });
    assert.deepEqual(changed.data.sources, priority);
    await eventually(async () => (await request('/status')).upstreams[0].connections.some(
      connection => connection.id === source && connection.feed === 'active'
    ));

    const rule = action === 'remove' ? { confirmation: true } : { destination: 'receiver', cameras: [camera.id], events: [type] };
    const result = await request(admin + '/callbacks', 'POST', { operationId: uuid(), id: callbackId, action, ...rule });
    assert.equal(result.outcome, 'confirmed');
    assert.equal(result.bridgeCorrelationId, result.correlationId);
    const stored = (await list()).callbacks.find(callback => callback.id === callbackId);
    if (action === 'remove') assert.equal(stored, undefined);
    else assert.deepEqual(stored, { id: callbackId, destination: new URL(FIXTURE_RECEIVER).origin, cameras: [camera.id], events: [type] });

    const upstream = await fetch(FIXTURE_BRIDGE + '/api/callbacks', {
      headers: { authorization: 'Bearer ' + FIXTURE_TOKEN }, signal: AbortSignal.timeout(4000)
    });
    assert.equal(upstream.status, 200);
    const wireRule = (await upstream.json()).callbacks.find(callback => callback.id === callbackId);
    if (action === 'remove') assert.equal(wireRule, undefined);
    else assert.deepEqual(wireRule, { id: callbackId, url: FIXTURE_RECEIVER, cameras: ['lab'], events: [type] });

    const offset = packets.length;
    const delivered = await nextBrowserEvent(base + '/events?camera=' + camera.id + '&type=' + type, headers, async () => {
      const response = await fetch(FIXTURE_INGRESS, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { event: 'wake', reason } }), signal: AbortSignal.timeout(4000)
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    });
    const raw = await eventually(() => packets.slice(offset).find(packet => packet.name === topic + 'events' && packet.body.type === type)?.body);
    assert.equal(raw.camera_id, 'lab');
    assert.equal(raw.stable_id, camera.deviceUid);
    assert.equal(delivered.camera, camera.id);
    assert.equal(delivered.event.type, type);
    assert.equal(delivered.event.source, 'reolink_webhook');
    assert.equal(delivered.event.vendorTopic, raw.vendor_topic);
    assert.equal(delivered.event.receivedAt, raw.received_at);
    const { events } = await request('/cameras/' + camera.id + '/events');
    const matches = events.filter(entry => entry.event.type === type && entry.event.receivedAt === raw.received_at);
    assert.deepEqual(matches, [{ id: delivered.id, observedAt: delivered.observedAt, event: delivered.event }]);

    if (action !== 'remove') expectedDeliveries.push(raw);
    const callbacks = await eventually(async () => {
      const response = await fetch(FIXTURE_RECEIVER, { signal: AbortSignal.timeout(4000) });
      assert.equal(response.status, 200);
      const received = await response.json();
      return received.length >= expectedDeliveries.length && received;
    });
    assert.deepEqual(callbacks, expectedDeliveries);
  }

  const settings = '/cameras/' + camera.id + '/settings/leds';
  const current = (await request(settings)).values.leds.status_led;
  assert.equal(typeof current, 'boolean');
  const operationId = uuid();
  const change = { setting: 'status_led', enabled: !current };
  const write = await request(settings, 'PATCH', { operationId, change });
  assert.equal(write.outcome, 'confirmed');
  assert.equal((await request(settings)).values.leds.status_led, !current);
  const command = packets.find(packet => packet.name === topic + 'command/exec' && packet.body.id === operationId);
  assert.deepEqual(command?.body.command, change);
  const reply = await eventually(() => packets.find(packet => packet.name === topic + 'command/result' && packet.body.id === operationId));
  assert.equal(reply.body.verified, true);
});
