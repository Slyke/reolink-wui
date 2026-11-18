import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { segment } from '../shared/urls.js';
import { bridgeSchema } from './config.js';
import { mergeBridgeCredentials } from './bridge-configuration.js';
import { input, uuid, type Runtime } from './runtime.js';
import { sendOutcome } from './camera-routes.js';
import { Failure } from './errors.js';

export const bridgeSettingsRoutes = ({ api, path, runtime }: { api: FastifyInstance; path: string; runtime: Runtime }) => {
  const body = z.strictObject({ operationId: uuid, configuration: z.record(z.string(), z.unknown()) });
  const save = async (request: Parameters<Runtime['admin']>[0]['request'], id?: string) => {
    const { account } = await runtime.admin({ request, mutate: true });
    const data = input({ schema: body, value: request.body });
    if (id && data.configuration.id !== undefined && data.configuration.id !== id) throw new Failure('BAD_INPUT',400);
    const previous = id ? runtime.bridges.get(id)?.config : undefined;
    if (id && !previous) throw new Failure('BAD_INPUT',404);
    const config = input({ schema: bridgeSchema, value: mergeBridgeCredentials({ value: data.configuration, previous, id }) });
    return runtime.ops.run({
      id: data.operationId, actor: account.id, resource: 'bridge:' + config.id,
      action: id ? 'bridge.configure' : 'bridge.add', input: data.configuration, correlation: request.id,
      execute: async () => {
        if (!id && runtime.bridges.has(config.id)) throw new Failure('OPERATION_CONFLICT',409);
        await runtime.configureBridge({value:data.configuration,id:config.id});
        return { outcome: 'confirmed', data: { id: config.id } };
      }
    });
  };
  api.post(path + '/admin/bridges', { bodyLimit: 262144 }, async (request, reply) =>
    sendOutcome({ reply, value: await save(request) }));
  api.put<{ Params: { id: string } }>(path + '/admin/bridges/:id', { bodyLimit: 262144 }, async (request, reply) => {
    const id = input({ schema: z.string().regex(segment), value: request.params.id });
    return sendOutcome({ reply, value: await save(request,id) });
  });
};
