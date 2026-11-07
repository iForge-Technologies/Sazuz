import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { mcpConnectionSchema, integrationId } from '@sazuz/config/integrations';
import {
  s2aInputSchema,
  s2aRecordSchema,
  s2aRunInputSchema,
  s2aUpdateSchema,
  s2aScheduleInputSchema,
  s2aScheduleSchema,
} from '@sazuz/core/s2a';
import { missionSchema } from '@sazuz/core/missions';
import {
  listS2a,
  publishS2a,
  readSettings,
  runS2a,
  saveS2a,
  saveSetting,
  s2aExecutions,
  missions,
  runs,
  projects,
  publicRun,
  s2aSchedules,
  s2aWorkflows,
  auditLog,
  workKey,
} from '@sazuz/db';
import { nextCronOccurrences } from '@sazuz/triggers';
import { createMcpClient, createMcpTools, inputValidator } from '@sazuz/mcp/connections';
import { s2aTools } from '@sazuz/workflows/s2a';
import { createChannelTool } from '@sazuz/channels';
import type { SecretReference } from '@sazuz/vault';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import type { PhaseThreeServices } from './phase-three.js';
import { RequestError } from './phase-one-errors.js';
import { parseRequest, workPath } from './phase-three-shared.js';
import { registerChannels } from './channels.js';

export function registerIntegrations(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  services: PhaseThreeServices,
  overrides: { fetch?: typeof fetch } = {},
) {
  const db = runtime.database;
  registerChannels(app, runtime, overrides);
  services.tools.replacePrefix('s2a.', s2aTools());
  services.tools.replacePrefix('channel.', [
    createChannelTool(() => {
      return Promise.reject(new Error('Channel actions execute only in the durable worker.'));
    }),
  ]);
  let mcpVersion = -1;
  const refresh = () => {
    if (mcpVersion === runtime.settings.advanced.version) return;
    services.tools.replacePrefix(
      'mcp_connection.',
      createMcpTools(() => runtime.settings.advanced.value.mcp),
    );
    mcpVersion = runtime.settings.advanced.version;
  };
  app.addHook('preHandler', (_request, _reply, done) => {
    refresh();
    done();
  });
  app.get('/api/mcp/connections', async (request) => {
    await runtime.admin(request);
    const settings = await readSettings(db);
    return { version: settings.advanced.version, connections: settings.advanced.value.mcp };
  });
  app.put('/api/mcp/connections', async (request) => {
    const { user } = await runtime.admin(request);
    const body = parseRequest(
      z.strictObject({
        version: z.number().int().nonnegative(),
        connections: z.array(mcpConnectionSchema).max(30),
      }),
      request.body,
    );
    try {
      for (const connection of body.connections) {
        const names = new Set<string>();
        for (const tool of connection.tools) {
          if (names.has(tool.name)) throw new Error();
          names.add(tool.name);
          inputValidator(tool.inputSchema);
        }
      }
    } catch {
      throw new RequestError(
        'MCP_SCHEMA',
        400,
        'A tool schema is unsupported or duplicated. Review discovery before saving.',
      );
    }
    const settings = await readSettings(db);
    const saved = await saveSetting(db, {
      namespace: 'advanced',
      value: { ...settings.advanced.value, mcp: body.connections },
      expectedVersion: body.version,
      actorId: user.id,
    });
    return { version: saved.version, connections: saved.value.mcp };
  });
  app.post('/api/mcp/discover', async (request) => {
    const { user } = await runtime.admin(request);
    await runtime.rateLimit(`mcp-discovery:${user.id}`, 10);
    const connection = parseRequest(mcpConnectionSchema, request.body);
    const client = createMcpClient(connection, {
      signal: AbortSignal.timeout(12_000),
      secret: (reference, consume) =>
        runtime.vault.withSecret(reference as SecretReference, 'user', consume),
    });
    try {
      const tools = await client.discover();
      const sessionCleanup = await client.close();
      if (sessionCleanup === 'failed')
        db.logger.warn(
          { code: 'MCP_CLEANUP_FAILED', connectionId: connection.id },
          'MCP discovery succeeded, but session cleanup failed.',
        );
      return { tools, sessionCleanup };
    } catch {
      throw new RequestError(
        'MCP_DISCOVERY_FAILED',
        502,
        'Could not discover tools. Check the HTTPS endpoint, credential, server support and schemas.',
      );
    } finally {
      await client.close();
    }
  });

  app.get('/api/s2a', async (request) => {
    const { user } = await runtime.admin(request);
    return z.array(s2aRecordSchema).parse(await listS2a(db, user.id));
  });
  app.post('/api/s2a', async (request) => {
    const { user } = await runtime.admin(request);
    return saveS2a(db, user.id, parseRequest(s2aInputSchema, request.body));
  });
  app.put('/api/s2a/:id', async (request) => {
    const { user } = await runtime.admin(request);
    const { id } = parseRequest(workPath, request.params);
    return saveS2a(db, user.id, parseRequest(s2aUpdateSchema, request.body), id);
  });
  app.post('/api/s2a/:id/publish', async (request) => {
    const { user } = await runtime.admin(request);
    const { id } = parseRequest(workPath, request.params);
    const body = parseRequest(
      z.strictObject({ revision: z.number().int().positive() }),
      request.body,
    );
    return publishS2a(db, user.id, id, body.revision);
  });
  app.post('/api/s2a/:id/run', async (request) => {
    const { user } = await runtime.admin(request);
    const { id } = parseRequest(workPath, request.params);
    await runtime.rateLimit(`s2a-run:${user.id}`, 30);
    const body = parseRequest(s2aRunInputSchema, request.body);
    const limits = runtime.settings.budgets.value;
    return missionSchema.parse(
      await runS2a(db, user.id, id, body, {
        maxSteps: limits.maxSteps,
        maxCostUsd: limits.perRunUsd,
        maxWallTimeSeconds: limits.maxWallTimeSeconds,
      }),
    );
  });
  app.get('/api/s2a/:id/runs', async (request) => {
    const { user } = await runtime.admin(request);
    const { id } = parseRequest(workPath, request.params);
    return (
      await db.orm
        .select({ run: runs, revision: s2aExecutions.revision, missionId: missions.id })
        .from(s2aExecutions)
        .innerJoin(runs, eq(runs.id, s2aExecutions.runId))
        .innerJoin(missions, eq(missions.id, runs.missionId))
        .innerJoin(projects, eq(projects.id, missions.projectId))
        .where(and(eq(projects.userId, user.id), eq(s2aExecutions.workflowId, id)))
        .orderBy(desc(runs.createdAt))
        .limit(100)
    ).map((row) => ({ ...row, run: publicRun(row.run) }));
  });
  app.get('/api/s2a/tools', async (request) => {
    await runtime.admin(request);
    refresh();
    return services.tools.list();
  });
  app.get('/api/s2a/:id/schedule', async (request) => {
    const { user } = await runtime.admin(request);
    const { id } = parseRequest(workPath, request.params);
    const [row] = await db.orm
      .select({ schedule: s2aSchedules })
      .from(s2aSchedules)
      .innerJoin(s2aWorkflows, eq(s2aWorkflows.id, s2aSchedules.workflowId))
      .innerJoin(projects, eq(projects.id, s2aWorkflows.projectId))
      .where(and(eq(projects.userId, user.id), eq(s2aSchedules.workflowId, id)));
    return row
      ? s2aScheduleSchema.parse({
          ...row.schedule,
          nextRunAt: row.schedule.nextRunAt.toISOString(),
        })
      : null;
  });
  app.put('/api/s2a/:id/schedule', async (request) => {
    const { user } = await runtime.admin(request);
    const { id } = parseRequest(workPath, request.params);
    const body = parseRequest(s2aScheduleInputSchema, request.body);
    const nextRunAt = new Date(
      nextCronOccurrences({
        expression: body.expression,
        timezone: body.timezone,
        now: new Date(),
        count: 1,
      })[0]!,
    );
    return db.orm.transaction(async (tx) => {
      const [workflow] = await tx
        .select({ workflow: s2aWorkflows })
        .from(s2aWorkflows)
        .innerJoin(projects, eq(projects.id, s2aWorkflows.projectId))
        .where(and(eq(s2aWorkflows.id, id), eq(projects.userId, user.id)));
      if (!workflow || !workflow.workflow.publishedRevision)
        throw new RequestError(
          'S2A_NOT_PUBLISHED',
          409,
          'Publish a workflow before scheduling it.',
        );
      const values = { ...body, version: body.version + 1, nextRunAt };
      const changed =
        body.version === 0
          ? await tx
              .insert(s2aSchedules)
              .values({ workflowId: id, ...values })
              .onConflictDoNothing()
              .returning()
          : await tx
              .update(s2aSchedules)
              .set(values)
              .where(and(eq(s2aSchedules.workflowId, id), eq(s2aSchedules.version, body.version)))
              .returning();
      if (!changed.length)
        throw new RequestError(
          'S2A_SCHEDULE_CONFLICT',
          409,
          'The schedule changed. Reload before saving.',
        );
      await tx
        .insert(auditLog)
        .values({ id: workKey('aud'), actorId: user.id, action: 's2a.schedule', target: id });
      return s2aScheduleSchema.parse({ ...changed[0], nextRunAt: nextRunAt.toISOString() });
    });
  });
  app.get('/api/mcp/:id/tools', async (request) => {
    await runtime.admin(request);
    const { id } = parseRequest(z.strictObject({ id: integrationId }), request.params);
    refresh();
    return services.tools.list().filter((tool) => tool.name.startsWith(`mcp_connection.${id}.`));
  });
}
