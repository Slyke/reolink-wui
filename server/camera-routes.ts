import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { record } from './bridge-channels.js';
import { presetRoutes, rememberPresetPosition } from './preset-routes.js';
import { readPresetPreferences } from '../shared/presets.js';
import { result } from './bridge.js';
import {
  available, capabilities, groupFor, groupSchema, information, ptzSchema, readback, rules,
  settingSchema, settingValues, statusPtz, validatePtz, validateSetting, visibleState
} from './cameras.js';
import { Failure } from './errors.js';
import { input, uuid, type Runtime } from './runtime.js';
import { validatePng } from './png.js';
import { jsonResponse } from './net.js';
import type { Permission } from '../shared/access.js';
import type { ActionResult } from './operations.js';

type Summary = { outcome: string; reason?: string };
export const sendOutcome = <T extends Summary>({ reply, value }: { reply: FastifyReply; value: T }) => (
  reply.code(value.outcome === 'pending' ? 202 : (value.outcome === 'unknown' ? 504 : (value.outcome === 'rejected' ? 422 : 200))).send(value)
);
const checkOnline = ({ bridge, row }: Awaited<ReturnType<Runtime['camera']>>) => {
  if (!available({ bridge, remote: row.routeId }).online) throw new Failure('CAMERA_OFFLINE', 409);
};

export const cameraRoutes = ({ api, path, runtime }: { api: FastifyInstance; path: string; runtime: Runtime }) => {
  const cameras = path + '/cameras';
  const scheduleReturn = presetRoutes({ api, cameras, runtime, sendOutcome });
  api.get(cameras, async request => {
    const { account } = await runtime.auth.require({ request });
    const cameras = await runtime.views({ account });
    return { cameras, ...(account.admin === 1 ? { inventory: runtime.inventoryState() } : {}) };
  });
  api.put(cameras + '/order', async request => {
    const { account } = await runtime.auth.require({ request, mutate: true });
    const { earlier, later } = input({ schema: z.strictObject({ earlier: uuid, later: uuid }).refine(pair => pair.earlier !== pair.later), value: request.body });
    return { order: await runtime.reorderCameras(account, earlier, later) };
  });
  api.get<{ Params: { id: string } }>(cameras + '/:id', async request => {
    const { row, bridge, grant } = await runtime.camera({ request, id: request.params.id, permission: 'view' });
    return { id: row.id, ...information({ state: bridge.state(row.routeId) }), ...visibleState({ bridge, remote: row.routeId, grant }) };
  });
  api.get<{ Params: { id: string } }>(cameras + '/:id/capabilities', async request => {
    const { row, bridge, grant } = await runtime.camera({ request, id: request.params.id, permission: 'view' });
    return capabilities({ bridge, remote: row.routeId, grant, proxy: !!row.rtsp_proxy });
  });

  api.get<{ Params: { id: string } }>(cameras + '/:id/events', async request => {
    const { row } = await runtime.camera({ request, id: request.params.id, permission: 'events' });
    return runtime.history.read({ camera: row.bridge_id + '/' + (row.history_key ?? row.remote_id) });
  });

  api.post<{ Params: { id: string } }>(cameras + '/:id/ptz', async (request, reply) => {
    const { operationId, action, interrupts } = input({
      schema: z.strictObject({ operationId: uuid, action: ptzSchema, interrupts: uuid.optional() }).refine(body => !body.interrupts || body.action.op === 'stop'),
      value: request.body
    });
    const read = action.op === 'status' || action.op === 'list_presets';
    const context = await runtime.camera({
      request, id: request.params.id, permission: read ? 'ptz.read' : 'ptz.write', mutate: true
    });
    const { row, bridge, grant, session } = context;
    const stop = action.op === 'stop';
    if (!stop && !read) checkOnline(context);
    validatePtz({ action, caps: capabilities({ bridge, remote: row.routeId, grant }).ptz });
    const before = Date.now();
    const operation = await runtime.ops.run<unknown>({
      id: operationId, actor: session.account.id, resource: row.id, correlation: request.id,
      action: 'ptz.' + action.op, input: { action, interrupts }, reconcileGroup: read || stop ? undefined : 'ptz',
      bypass: stop, serialized: !read,
      execute: async () => {
        if (['move','stop','goto_preset','set_zoom','delete_preset','save_preset'].includes(action.op)) {
          await runtime.sql.query('UPDATE cameras SET ptz_intent=$1 WHERE id=$2',operationId,row.id);
        }
        if (interrupts) {
          await runtime.sql.transaction(async query => {
            await query('DELETE FROM ptz_interrupts WHERE expires <= $1', Date.now());
            await query('INSERT INTO ptz_interrupts(movement,actor,camera,expires) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
              interrupts, session.account.id, row.id, Date.now() + 120_000);
          });
        }
        if (action.op === 'move' && (await runtime.sql.query(
          'SELECT movement FROM ptz_interrupts WHERE movement=$1 AND actor=$2 AND camera=$3 AND expires>$4', operationId, session.account.id, row.id, Date.now()
        )).length) {
          return { outcome: 'rejected', reason: 'PTZ_CANCELLED' };
        }
        const response = await bridge.command({ camera: row.routeId, stableId: row.remote_id, id: operationId, command: { setting: 'ptz', action }, correlation: request.id });
        const outcome = result({ reply: response, write: !read });
        // Native timed_move returns these Start errors only after an acknowledged Stop.
        // A failed Stop has its own error and must keep the unknown-outcome barrier.
        if (action.op === 'move' && ['PTZ_START_INTERRUPTED','PTZ_MOVE_START_FAILED'].includes(String(response.errorKey))) {
          return {outcome:'unverified',bridgeCorrelationId:outcome.bridgeCorrelationId,
            data:{stopped:true,startAcknowledged:false,interrupted:response.errorKey==='PTZ_START_INTERRUPTED'}};
        }
        if (response.errorKey === 'PTZ_PRESET_OCCUPIED') return { ...outcome, outcome:'rejected', reason:'PTZ_PRESET_OCCUPIED' };
        let retryAfterMs: number | undefined;
        if (action.op === 'status' && response.ok === true) {
          await runtime.ops.reconcile({camera:row.id,group:'ptz',before});
          retryAfterMs = await runtime.ops.ptzRecoveryDelay(row.id) || undefined;
        }
        if (response.ok === true) {
          const status = statusPtz({ raw: record(response.result) });
          if (action.op === 'save_preset' && outcome.outcome === 'confirmed') {
            await rememberPresetPosition(runtime.sql,row.id,action.preset_id,action.name,status.position);
          }
          if (action.op === 'delete_preset' && outcome.outcome === 'confirmed') {
            await runtime.sql.transaction(async query => {
              await query('DELETE FROM preset_positions WHERE camera=$1 AND slot=$2', row.id, action.preset_id);
              const [current] = await query<{ ptz_preferences: string | null }>('SELECT ptz_preferences FROM cameras WHERE id=$1', row.id);
              const prefs = readPresetPreferences(current.ptz_preferences);
              prefs.order = prefs.order.filter(slot => slot !== action.preset_id);
              if (prefs.returnPreset === action.preset_id) prefs.returnPreset = null;
              await query('UPDATE cameras SET ptz_preferences=$1 WHERE id=$2', JSON.stringify(prefs), row.id);
            });
          }
          if (action.op === 'goto_preset') {
            const prefs = readPresetPreferences(row.ptz_preferences);
            if (prefs.returnPreset !== null && prefs.returnPreset !== action.preset_id) {
              scheduleReturn(row.id,session.account.id,operationId,prefs.returnPreset,prefs.returnSeconds,request.id);
            }
          }
          const preferences = action.op === 'list_presets' ? readPresetPreferences(row.ptz_preferences) : undefined;
          return { ...outcome, data: grant.has('ptz.read') ? {...status,retryAfterMs,preferences} : { stopped: status.stopped, interrupted: status.interrupted } };
        }
        return outcome;
      }
    });
    return sendOutcome({ reply, value: operation });
  });

  const update = async ({ request, reply, id, alert, group }: {
    request: Parameters<Runtime['camera']>[0]['request']; reply: FastifyReply; id: string; alert: boolean; group: string
  }) => {
    const fields = input({ schema: z.strictObject({ operationId: uuid, change: settingSchema }), value: request.body });
    const key = groupFor(fields.change.setting);
    if (group !== key || (alert && key !== 'motion')) throw new Failure('BAD_INPUT', 400);
    const context = await runtime.camera({ request, id, permission: alert ? 'alerts.write' : 'settings.' + key + '.write' as Permission, mutate: true });
    const { row, bridge, grant, session } = context;
    checkOnline(context);
    validateSetting({ value: fields.change, settings: capabilities({ bridge, remote: row.routeId, grant }).settings });
    const operation = await runtime.ops.run({
      id: fields.operationId, actor: session.account.id, resource: row.id, action: (alert ? 'alerts.' : 'settings.') + fields.change.setting,
      input: fields.change, reconcileGroup: key, serialized: true, correlation: request.id,
      execute: async () => {
        const response = await bridge.command({ camera: row.routeId, stableId: row.remote_id, id: fields.operationId, command: fields.change, correlation: request.id });
        const outcome = result({ reply: response, write: true });
        const values = response.ok === true && grant.has(alert ? 'alerts.read' : 'settings.' + key + '.read' as Permission)
          ? readback({ raw: record(response.state), group: key, className: fields.change.setting === 'ai_detection' ? fields.change.class : undefined })
          : undefined;
        return { ...outcome, data: values };
      }
    });
    return sendOutcome({ reply, value: operation });
  };
  api.patch<{ Params: { id: string; group: string } }>(cameras + '/:id/settings/:group', (request, reply) =>
    update({ request, reply, id: request.params.id, alert: false, group: request.params.group }));
  api.patch<{ Params: { id: string; ruleId: string } }>(cameras + '/:id/alerts/:ruleId', (request, reply) =>
    update({ request, reply, id: request.params.id, alert: true, group: request.params.ruleId }));

  const settings = async ({ request, id, alert, group, fresh }: {
    request: Parameters<Runtime['camera']>[0]['request']; id: string; alert: boolean; group: string; fresh: boolean
  }) => {
    const key = input({ schema: groupSchema, value: group });
    const context = await runtime.camera({ request, id, permission: alert ? 'alerts.read' : 'settings.' + key + '.read' as Permission });
    const { row, bridge } = context;
    const state = bridge.state(row.routeId);
    let values = settingValues({ raw: state.get('state/settings') ?? {}, group: key });
    if (fresh) {
      checkOnline(context);
      if (!bridge.has('v1')) throw new Failure('UNSUPPORTED', 422);
      const before = Date.now();
      const response = await bridge.api({ stableId: row.remote_id, path: '/cameras/' + row.routeId + '/settings/' + key, correlation: request.id });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Failure(response.status === 422 ? 'UNSUPPORTED' : 'BRIDGE_UNAVAILABLE', response.status === 422 ? 422 : 502);
      }
      values = settingValues({ raw: record(record(await jsonResponse({ response })).values), group: key });
      if (!Object.keys(values).length) throw new Failure('BRIDGE_UNAVAILABLE', 502);
      await runtime.ops.reconcile({ camera: row.id, group: key, before });
    }
    return {
      values, fresh, availability: available({ bridge, remote: row.routeId }),
      ...(alert ? { rules: rules({ raw: state.get('rules') ?? {} }), liveWrites: ['motion'] } : {})
    };
  };
  const freshQuery = z.strictObject({ fresh: z.literal('true').optional() });
  api.get<{ Params: { id: string; group: string } }>(cameras + '/:id/settings/:group', request =>
    settings({ request, id: request.params.id, group: request.params.group, alert: false, fresh: !!input({ schema: freshQuery, value: request.query }).fresh }));
  api.get<{ Params: { id: string } }>(cameras + '/:id/alerts', request =>
    settings({ request, id: request.params.id, group: 'motion', alert: true, fresh: !!input({ schema: freshQuery, value: request.query }).fresh }));

  api.post<{ Params: { id: string } }>(cameras + '/:id/snapshots', async (request, reply) => {
    const { operationId } = input({ schema: z.strictObject({ operationId: uuid }), value: request.body });
    const context = await runtime.camera({ request, id: request.params.id, mutate: true, permission: 'capture' });
    const { bridge, grant, row, session } = context;
    checkOnline(context);
    if (!capabilities({ bridge, remote: row.routeId, grant }).capture) throw new Failure('UNSUPPORTED', 422);
    const operation = await runtime.ops.run<Buffer>({
      id: operationId, actor: session.account.id, resource: row.id, action: 'capture', input: null, correlation: request.id,
      execute: async (): Promise<ActionResult<Buffer>> => {
        const response = await bridge.command({ camera: row.routeId, stableId: row.remote_id, id: operationId, command: { setting: 'snapshot' }, capture: true, correlation: request.id });
        return { ...result({ reply: response, write: false }), data: response.ok === true ? validatePng({ result: response.result }) : undefined };
      }
    });
    if (!operation.data) return sendOutcome({ reply, value: operation });
    if (operation.bridgeCorrelationId) reply.header('x-bridge-correlation-id', operation.bridgeCorrelationId);
    return reply.type('image/png').header('content-disposition', 'inline; filename="snapshot.png"').send(operation.data);
  });
};
