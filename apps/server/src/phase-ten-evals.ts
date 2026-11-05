import { z } from 'zod';
import { withActivity } from '@sazuz/db';
import {
  evalReportSchema,
  evalRequestSchema,
  evalRunSchema,
  evalSuiteSummarySchema,
} from '@sazuz/core/evals';
import {
  builtinSuites,
  evaluationReport,
  executeEvaluation,
  listEvaluations,
  nextEvaluation,
  renderEvalHtml,
  startEvaluation,
  suiteSummary,
} from '@sazuz/evals';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { createModelServices } from './phase-two.js';
import { RequestError } from './phase-one-errors.js';
import { emptyRequest, parseRequest, workPath } from './phase-three-shared.js';

export function registerEvaluations(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  options: { background?: boolean } = {},
) {
  for (const operator of [false, true]) {
    const base = operator ? '/api/operator/evals' : '/api/evals';
    const owner = async (request: Parameters<typeof runtime.admin>[0]) => {
      if (!operator) return (await runtime.admin(request)).user.id;
      // The shared Phase One hook requires both loopback and the private operator bearer.
      const id = (await runtime.state()).adminId;
      if (!id)
        throw new RequestError(
          'SETUP_REQUIRED',
          409,
          'Complete setup before configured evaluations.',
        );
      return id;
    };
    app.get(
      `${base}/suites`,
      {
        schema: { querystring: emptyRequest, response: { 200: z.array(evalSuiteSummarySchema) } },
      },
      async (request) => {
        await owner(request);
        return builtinSuites(true).map(suiteSummary);
      },
    );
    app.get(
      base,
      {
        schema: { querystring: emptyRequest, response: { 200: z.array(evalRunSchema) } },
      },
      async (request) => listEvaluations(runtime.database, await owner(request)),
    );
    app.post(
      base,
      {
        schema: {
          querystring: emptyRequest,
          body: evalRequestSchema,
          response: { 200: evalRunSchema },
        },
      },
      async (request) => {
        const userId = await owner(request);
        await runtime.rateLimit(`evals:${userId}`, 20);
        return startEvaluation(
          runtime.database,
          userId,
          parseRequest(evalRequestSchema, request.body),
          runtime.settings,
        );
      },
    );
    app.get(
      `${base}/:id`,
      {
        schema: {
          querystring: emptyRequest,
          params: workPath,
          response: { 200: evalReportSchema },
        },
      },
      async (request) =>
        evaluationReport(
          runtime.database,
          await owner(request),
          parseRequest(workPath, request.params).id,
        ),
    );
    app.get(
      `${base}/:id/report`,
      {
        schema: { querystring: emptyRequest, params: workPath },
      },
      async (request, reply) => {
        const report = await evaluationReport(
          runtime.database,
          await owner(request),
          parseRequest(workPath, request.params).id,
        );
        reply.header(
          'Content-Security-Policy',
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox",
        );
        reply.header('X-Content-Type-Options', 'nosniff');
        return reply.type('text/html; charset=utf-8').send(renderEvalHtml(report));
      },
    );
  }
  if (options.background === false) return;
  const { router } = createModelServices(runtime);
  const abort = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  const poll = async () => {
    if (!(await runtime.state()).completedAt) return;
    const id = await nextEvaluation(runtime.database);
    if (id)
      await executeEvaluation(
        {
          database: runtime.database,
          getSettings: () => runtime.settings,
          generate: (request) => router.generate(request),
          signal: abort.signal,
        },
        id,
      );
  };
  app.addHook('onReady', (done) => {
    timer = setInterval(() => {
      if (pending) return;
      pending = withActivity(runtime.database, poll)
        .catch(() => {
          runtime.database.logger.warn(
            { code: 'EVAL_EXECUTION_FAILED' },
            'Evaluation stopped; inspect its retained report before starting another.',
          );
        })
        .finally(() => {
          pending = undefined;
        });
    }, 1000);
    timer.unref();
    done();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    abort.abort();
    await pending;
  });
}
