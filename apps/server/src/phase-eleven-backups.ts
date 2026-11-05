import { z } from 'zod';
import { acquireActivity } from '@sazuz/db';
import { createOperations, recoverOperations, type DatabaseSnapshot } from '@sazuz/ops';
import {
  backupCreateSchema,
  backupIdSchema,
  backupStatusSchema,
  operationIdSchema,
  operationSchema,
  OperationsError,
  restoreBeginSchema,
  restoreChunkSchema,
  restoreCompleteSchema,
  restoreUploadSchema,
} from '@sazuz/core/operations';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { emptyRequest, parseRequest } from './phase-three-shared.js';
import {
  bindRequestActivity,
  endRequestResponse,
  releaseRequestActivity,
} from './request-activity.js';

export function registerBackups(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  options: { snapshot?: DatabaseSnapshot; restored?: () => void; background?: boolean } = {},
) {
  const service = createOperations({
    database: runtime.database,
    config: runtime.config,
    vault: runtime.vault,
    ...(options.snapshot ? { snapshot: options.snapshot } : {}),
  });
  const params = z.strictObject({ id: operationIdSchema });
  const activities = new Map<string, { release: () => Promise<void>; started: boolean }>();
  app.addHook('onRequest', async (request, reply) => {
    if (
      request.url === '/api/health' ||
      /^\/api\/(?:operator\/)?(?:backups|operations|setup\/restore)(?:\/|$)/.test(request.url)
    )
      return;
    const release = await acquireActivity(runtime.database);
    if (!release) throw new OperationsError('OPS_BUSY');
    if (request.raw.aborted || reply.raw.destroyed) {
      // The transport can close while database admission is pending, before the
      // activity and close listener exist. Do not parse or execute that request.
      await release();
      reply.hijack();
      return;
    }
    activities.set(request.id, { release, started: false });
    bindRequestActivity(request, () => finish(request.id));
    reply.raw.once('close', () => {
      void endRequestResponse(request).catch(() =>
        runtime.database.logger.error(
          { code: 'OPS_RESPONSE_RELEASE_FAILED' },
          'A response activity lease requires recovery.',
        ),
      );
    });
  });
  const finish = async (id: string) => {
    const done = activities.get(id);
    activities.delete(id);
    await done?.release();
  };
  app.addHook('preHandler', (request, _reply, done) => {
    const activity = activities.get(request.id);
    if (activity) activity.started = true;
    done();
  });
  app.addHook('onSend', async (request, _reply, payload) => {
    await endRequestResponse(request, true);
    return payload;
  });
  app.addHook('onResponse', async (request) => endRequestResponse(request, true));
  // Disconnecting a client does not prove that its already-started mutation has stopped.
  app.addHook('onRequestAbort', async (request) => {
    if (!activities.get(request.id)?.started) await releaseRequestActivity(request);
    else await endRequestResponse(request);
  });
  app.addHook('onTimeout', async (request) => {
    if (!activities.get(request.id)?.started) await releaseRequestActivity(request);
    else await endRequestResponse(request);
  });
  async function owner() {
    const state = await runtime.state();
    if (!state.adminId) throw new OperationsError('OPS_FRESH_REQUIRED');
    return state.adminId;
  }
  for (const prefix of ['/api', '/api/operator']) {
    app.get(
      `${prefix}/backups`,
      { schema: { querystring: emptyRequest, response: { 200: backupStatusSchema } } },
      async (request) => {
        const userId = prefix === '/api' ? (await runtime.admin(request)).user.id : await owner();
        return service.status(userId);
      },
    );
    app.post(
      `${prefix}/backups`,
      { schema: { body: backupCreateSchema, response: { 200: operationSchema } } },
      async (request) => {
        const userId = prefix === '/api' ? (await runtime.admin(request)).user.id : await owner();
        await runtime.rateLimit('backup-create', 5, 300);
        request.raw.socket?.setTimeout?.(150000);
        return service.create(userId, request.body);
      },
    );
    app.get(
      `${prefix}/backups/:id/download`,
      { schema: { params: z.strictObject({ id: backupIdSchema }), querystring: emptyRequest } },
      async (request, reply) => {
        const userId = prefix === '/api' ? (await runtime.admin(request)).user.id : await owner();
        const { bytes, backup } = await service.download(userId, request.params.id);
        reply.header('Content-Disposition', `attachment; filename="${backup.id}.sazuz"`);
        reply.header('X-Backup-SHA256', backup.sha256);
        return reply.type('application/octet-stream').send(bytes);
      },
    );
  }
  for (const prefix of ['/api/setup/restore', '/api/operator/setup/restore']) {
    const gate = async (request: Parameters<PhaseOne['requireSetup']>[0]) => {
      if (prefix === '/api/setup/restore') await runtime.requireSetup(request, false);
      await service.requireFresh();
    };
    app.post(
      prefix,
      { schema: { body: restoreBeginSchema, response: { 200: restoreUploadSchema } } },
      async (request) => {
        await gate(request);
        await runtime.rateLimit('restore-begin', 6, 300);
        return service.begin(request.body);
      },
    );
    app.get(
      `${prefix}/:id`,
      { schema: { params, querystring: emptyRequest, response: { 200: restoreUploadSchema } } },
      async (request) => {
        await gate(request);
        return service.uploadStatus(request.params.id);
      },
    );
    app.post(
      `${prefix}/:id/chunks`,
      { schema: { params, body: restoreChunkSchema, response: { 200: restoreUploadSchema } } },
      async (request) => {
        await gate(request);
        return service.chunk(request.params.id, request.body);
      },
    );
    app.post(
      `${prefix}/:id/complete`,
      { schema: { params, body: restoreCompleteSchema, response: { 200: operationSchema } } },
      async (request, reply) => {
        await gate(request);
        await runtime.rateLimit('restore-credential', 5, 300);
        request.raw.socket?.setTimeout?.(150000);
        try {
          const result = await service.complete(request.params.id, request.body);
          reply.header('Set-Cookie', 'sazuz-setup=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
          return result;
        } finally {
          if (service.restartRequired) {
            const timer = setTimeout(() => options.restored?.(), 250);
            timer.unref();
          }
        }
      },
    );
  }
  app.get('/api/operations/status', async (request) => {
    parseRequest(emptyRequest, request.query);
    return service.status((await runtime.admin(request)).user.id);
  });
  let timer: ReturnType<typeof setInterval> | undefined, pending: Promise<void> | undefined;
  app.addHook('onReady', async () => {
    if (options.background === false) return;
    await recoverOperations(runtime.database);
    timer = setInterval(() => {
      if (pending) return;
      pending = service
        .tick()
        .catch((error) =>
          runtime.database.logger.warn(
            { code: error instanceof OperationsError ? error.code : 'OPS_POLL_FAILED' },
            'An operation needs attention in Backups.',
          ),
        )
        .finally(() => {
          pending = undefined;
        });
    }, 30000);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await pending;
    for (const id of activities.keys()) await finish(id);
  });
  return service;
}
