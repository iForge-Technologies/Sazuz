import { updatePrepareSchema, updateStatusSchema, OperationsError } from '@sazuz/core/operations';
import { createUpdates, type Operations } from '@sazuz/ops';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { emptyRequest } from './phase-three-shared.js';

export function registerUpdates(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  backups: Operations,
) {
  const service = createUpdates({
    database: runtime.database,
    config: runtime.config,
    vault: runtime.vault,
    backups,
  });
  app.get(
    '/api/operations/updates',
    { schema: { querystring: emptyRequest, response: { 200: updateStatusSchema.nullable() } } },
    async (request) => service.status((await runtime.admin(request)).user.id),
  );
  app.post(
    '/api/operator/operations/updates/prepare',
    { schema: { body: updatePrepareSchema, response: { 200: updateStatusSchema } } },
    async (request) => {
      const state = await runtime.state();
      if (!state.adminId || !state.completedAt) throw new OperationsError('OPS_FRESH_REQUIRED');
      request.raw.socket?.setTimeout?.(150000);
      return service.prepare(state.adminId, request.body);
    },
  );
  app.post(
    '/api/operator/operations/updates/activate',
    { schema: { body: emptyRequest, response: { 200: updateStatusSchema } } },
    () => service.activate(),
  );
  return service;
}
