import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validWifiName, validWifiPassword, type CameraNetwork, type RtspSettings } from '../shared/network.js';
import { correlationPattern } from '../shared/urls.js';
import { record } from './bridge-channels.js';
import { sendOutcome } from './camera-routes.js';
import { Failure } from './errors.js';
import { jsonResponse } from './net.js';
import { input, uuid, type Runtime } from './runtime.js';

const settings = z.strictObject({
  operationId: uuid, ssid: z.string().refine(validWifiName), password: z.string().max(64),
  open: z.boolean(), confirmation: z.literal(true)
}).refine(({password, open}) => validWifiPassword(password, open));
const rtspPort = z.number().int().min(1).max(65535).nullable();
const rtspState = z.discriminatedUnion('supported', [
  z.object({supported:z.literal(false)}),
  z.object({supported:z.literal(true),enabled:z.boolean(),port:rtspPort})
]);
const rtspIntent = z.strictObject({operationId:uuid,enabled:z.boolean()});
const ip = z.string().refine(value => isIP(value) !== 0).nullable();
const networkInterface = z.object({addresses:z.array(z.string().refine(value=>isIP(value)!==0)),active:z.boolean().nullable(),enabled:z.boolean().nullable(),dhcp:z.boolean().nullable()}).nullable();
const status = z.object({
  interfaces:z.object({ethernet:networkInterface,wifi:networkInterface}).optional(),
  wifiStatus:z.object({associated:z.boolean().nullable(),ssid:z.string().refine(validWifiName).nullable(),
    signal:z.enum(['None','Very Bad','Bad','Good','Very Good']).nullable()}).optional(),
  wifiSignal:z.number().int().min(-127).max(100).nullable().optional(),wifiSwitchAvailable:z.boolean().optional(),
  link: z.object({address: ip, netmask: ip, gateway: ip, dhcp: z.boolean().nullable()}).nullable(),
  wifi: z.object({ssid: z.string().refine(validWifiName).nullable(), nearby: z.array(z.string().refine(validWifiName)).max(128), configurable: z.boolean()}).nullable()
});

export function networkRoutes({api, path, runtime}: {api: FastifyInstance; path: string; runtime: Runtime}) {
  const endpoint = path + '/cameras/:id/network';
  api.get<{Params:{id:string}}>(endpoint + '/rtsp', async request => {
    const {row,bridge} = await runtime.camera({request,id:request.params.id,permission:'settings.network.read'});
    if (!bridge.hasNetwork(row.routeId) || !bridge.has('rtspSettings')) throw new Failure('UNSUPPORTED',422);
    const response = await bridge.api({stableId:row.remote_id,path:'/cameras/'+row.routeId+'/network/rtsp',correlation:request.id,signal:AbortSignal.timeout(22_000)});
    if (!response.ok) throw new Failure(response.status === 409 ? 'CAMERA_UNKNOWN' : 'BRIDGE_UNAVAILABLE',502);
    const state = rtspState.safeParse(await jsonResponse({response}));
    if (!state.success) throw new Failure('BRIDGE_UNAVAILABLE',502);
    return state.data satisfies RtspSettings;
  });
  api.put<{Params:{id:string}}>(endpoint + '/rtsp', async (request,reply) => {
    const {row,bridge,session} = await runtime.camera({request,id:request.params.id,permission:'settings.network.write',mutate:true});
    if (!bridge.hasNetwork(row.routeId) || !bridge.has('rtspSettings')) throw new Failure('UNSUPPORTED',422);
    const {operationId,enabled} = input({schema:rtspIntent,value:request.body});
    const value = await runtime.ops.run({id:operationId,actor:session.account.id,resource:row.id,action:'settings.network.rtsp',correlation:request.id,input:{enabled},execute:async () => {
      const response = await bridge.api({stableId:row.remote_id,path:'/cameras/'+row.routeId+'/network/rtsp',method:'PUT',data:{enabled},correlation:request.id,signal:AbortSignal.timeout(30_000)});
      const body = record(await jsonResponse({response}));
      const bridgeCorrelationId = typeof body.correlation_id === 'string' && correlationPattern.test(body.correlation_id) ? body.correlation_id : undefined;
      const port = rtspPort.safeParse(body.port);
      if (response.ok && body.outcome === 'confirmed' && body.enabled === enabled && port.success)
        return {outcome:'confirmed',data:{enabled,port:port.data},bridgeCorrelationId};
      const reasons = {API_RTSP_REJECTED:'COMMAND_REJECTED',API_RTSP_UNSUPPORTED:'UNSUPPORTED',API_RTSP_INVALID:'BAD_INPUT',
        API_NETWORK_BUSY:'COMMAND_BUSY',API_READ_BUSY:'COMMAND_BUSY',API_CAMERA_IDENTITY_CHANGED:'CAMERA_UNKNOWN',API_NETWORK_READ_FAILED:'BRIDGE_UNAVAILABLE'} as const;
      const reason = typeof body.errorKey === 'string' && Object.hasOwn(reasons,body.errorKey) ? reasons[body.errorKey as keyof typeof reasons] : undefined;
      return reason ? {outcome:'rejected',reason,bridgeCorrelationId} : {outcome:'unknown',reason:'OUTCOME_UNKNOWN',bridgeCorrelationId};
    }});
    return sendOutcome({reply,value});
  });
  api.put<{Params:{id:string}}>(endpoint+'/wifi', async (request,reply) => {
    const {row,bridge,session}=await runtime.camera({request,id:request.params.id,permission:'settings.network.write',mutate:true});
    if (!bridge.hasNetwork(row.routeId)) throw new Failure('UNSUPPORTED',422);
    const {operationId,enabled,confirmation}=input({schema:z.strictObject({operationId:uuid,enabled:z.boolean(),confirmation:z.literal(true)}),value:request.body});
    const value=await runtime.ops.run({id:operationId,actor:session.account.id,resource:row.id,action:'settings.network.wifi',correlation:request.id,input:{enabled},serialized:true,
      execute:async()=>{
        const response=await bridge.api({stableId:row.remote_id,path:'/cameras/'+row.routeId+'/network/wifi',method:'PUT',data:{enabled,confirmation},correlation:request.id,signal:AbortSignal.timeout(38_000)});
        const body=record(await jsonResponse({response}));
        const bridgeCorrelationId=typeof body.correlation_id==='string' && correlationPattern.test(body.correlation_id) ? body.correlation_id : undefined;
        if (response.ok && body.outcome==='confirmed' && body.enabled===enabled) return {outcome:'confirmed',bridgeCorrelationId,data:{enabled}};
        if (body.errorKey==='API_WIFI_REBOOT_REQUIRED') return {outcome:'unverified',reason:'WIFI_REBOOT_REQUIRED',bridgeCorrelationId};
        const reasons={API_NETWORK_WIRED_REQUIRED:'WIFI_WIRED_REQUIRED',API_NETWORK_UNSUPPORTED:'UNSUPPORTED',API_NETWORK_INVALID:'BAD_INPUT',API_NETWORK_BUSY:'COMMAND_BUSY',
          API_READ_BUSY:'COMMAND_BUSY',API_CAMERA_IDENTITY_CHANGED:'CAMERA_UNKNOWN',API_NETWORK_READ_FAILED:'BRIDGE_UNAVAILABLE'} as const;
        const key=typeof body.errorKey==='string' && Object.hasOwn(reasons,body.errorKey) ? body.errorKey as keyof typeof reasons : undefined;
        return key ? {outcome:'rejected',reason:reasons[key],bridgeCorrelationId} : {outcome:'unknown',reason:'OUTCOME_UNKNOWN',bridgeCorrelationId};
      }});
    return sendOutcome({reply,value});
  });
  api.get<{Params:{id:string}}>(endpoint, async request => {
    const { row, bridge } = await runtime.camera({request, id: request.params.id, permission:'settings.network.read'});
    if (!bridge.hasNetwork(row.routeId)) throw new Failure('UNSUPPORTED',422);
    const response = await bridge.api({stableId:row.remote_id,path:'/cameras/'+row.routeId+'/network',correlation:request.id,signal:AbortSignal.timeout(22_000)});
    if (!response.ok) throw new Failure(response.status === 409 ? 'CAMERA_UNKNOWN' : 'BRIDGE_UNAVAILABLE',502);
    const parsed = status.safeParse(await jsonResponse({response}));
    if (!parsed.success) throw new Failure('BRIDGE_UNAVAILABLE',502);
    return parsed.data satisfies CameraNetwork;
  });
  api.put<{Params:{id:string}}>(endpoint, async (request, reply) => {
    const {row,bridge,session} = await runtime.camera({request,id:request.params.id,permission:'settings.network.write',mutate:true});
    if (!bridge.hasNetwork(row.routeId) || !bridge.config.http) throw new Failure('UNSUPPORTED',422);
    const {operationId, ...intent} = input({schema:settings,value:request.body});
    // Only a keyed fingerprint enters the operation log. Wi-Fi credentials travel to this bridge over its HTTP API.
    const fingerprint = createHmac('sha256',bridge.config.http.token).update(JSON.stringify([operationId,intent.ssid,intent.password,intent.open])).digest('hex');
    const value = await runtime.ops.run({id:operationId,actor:session.account.id,resource:row.id,action:'settings.network',correlation:request.id,input:fingerprint,execute:async () => {
      const response = await bridge.api({stableId:row.remote_id,path:'/cameras/'+row.routeId+'/network',method:'PUT',data:intent,correlation:request.id,signal:AbortSignal.timeout(28_000)});
      const body = record(await jsonResponse({response}));
      const bridgeCorrelationId = typeof body.correlation_id === 'string' && correlationPattern.test(body.correlation_id) ? body.correlation_id : undefined;
      if (response.ok && (body.outcome === 'confirmed' || body.outcome === 'unverified')) return {outcome:body.outcome,bridgeCorrelationId,data:{ssidVerified:body.ssidVerified === true}};
      const reasons = {API_NETWORK_REJECTED:'COMMAND_REJECTED', API_NETWORK_BUSY:'COMMAND_BUSY', API_READ_BUSY:'COMMAND_BUSY',
        API_NETWORK_INVALID:'BAD_INPUT',API_NETWORK_UNSUPPORTED:'UNSUPPORTED',API_CAMERA_IDENTITY_CHANGED:'CAMERA_UNKNOWN',API_NETWORK_READ_FAILED:'BRIDGE_UNAVAILABLE'} as const;
      const key = typeof body.errorKey === 'string' && Object.hasOwn(reasons,body.errorKey) ? body.errorKey as keyof typeof reasons : undefined;
      return key ? {outcome:'rejected',reason:reasons[key],bridgeCorrelationId} : {outcome:'unknown',reason:'OUTCOME_UNKNOWN',bridgeCorrelationId};
    }});
    return sendOutcome({reply,value});
  });
}
