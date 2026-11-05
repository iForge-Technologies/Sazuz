import { z } from 'zod';
import { forkInputSchema, runDetailSchema } from '@sazuz/core/replay';
import { forkRun, runDetail } from '@sazuz/runtime';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { emptyRequest, parseRequest, workPath } from './phase-three-shared.js';
import { registerObservability } from './phase-ten-observability.js';
import { registerEvaluations } from './phase-ten-evals.js';

export function registerPhaseTen(app: Awaited<ReturnType<typeof createApp>>, runtime: PhaseOne) {
  registerObservability(app, runtime);
  registerEvaluations(app, runtime);
  app.get(
    '/api/runs/:id/detail',
    {
      schema: {
        params: z.strictObject({ id: workPath.shape.id }),
        response: { 200: runDetailSchema },
      },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      parseRequest(emptyRequest, request.query);
      const { id } = parseRequest(workPath, request.params);
      return runDetail(runtime.database, user.id, id);
    },
  );
  app.post(
    '/api/runs/:id/forks',
    { schema: { params: workPath, body: forkInputSchema, response: { 200: runDetailSchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      parseRequest(emptyRequest, request.query);
      const { id } = parseRequest(workPath, request.params);
      await runtime.rateLimit(`forks:${user.id}`, 20);
      return forkRun(
        runtime.database,
        user.id,
        id,
        parseRequest(forkInputSchema, request.body),
        runtime.settings,
      );
    },
  );
}
