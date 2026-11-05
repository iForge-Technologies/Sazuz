import { collectCostAlerts, costDashboard, withActivity } from '@sazuz/db';
import {
  costDashboardSchema,
  costQuerySchema,
  telemetryStatusSchema,
} from '@sazuz/core/observability';
import { exportTelemetry, telemetryStatus } from '@sazuz/runtime';
import type { SecretReference } from '@sazuz/vault';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { emptyRequest, parseRequest } from './phase-three-shared.js';

export function registerObservability(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
) {
  app.get(
    '/api/costs/dashboard',
    { schema: { querystring: costQuerySchema, response: { 200: costDashboardSchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      const { projectId } = parseRequest(costQuerySchema, request.query);
      return costDashboard(runtime.database, user.id, runtime.settings, projectId);
    },
  );
  app.get(
    '/api/observability/status',
    { schema: { response: { 200: telemetryStatusSchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      parseRequest(emptyRequest, request.query);
      return telemetryStatus(runtime.database, user.id, runtime.settings);
    },
  );
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  const abort = new AbortController();
  async function poll() {
    const installation = await runtime.state();
    if (!installation.completedAt || !installation.adminId) return;
    await collectCostAlerts(runtime.database, installation.adminId, runtime.settings);
    await exportTelemetry({
      database: runtime.database,
      userId: installation.adminId,
      getSettings: () => runtime.settings,
      signal: abort.signal,
      withSecret: (reference, consume) =>
        runtime.vault.withSecret(reference as SecretReference, 'user', consume),
    });
  }
  app.addHook('onReady', (done) => {
    timer = setInterval(() => {
      if (pending) return;
      pending = withActivity(runtime.database, poll)
        .catch(() => {
          runtime.database.logger.warn(
            { code: 'OBSERVABILITY_POLL_FAILED' },
            'Observability collection will continue on the next interval.',
          );
        })
        .finally(() => {
          pending = undefined;
        });
    }, 10_000);
    timer.unref();
    done();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    abort.abort();
    await pending;
  });
}
