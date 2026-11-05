import { and, desc, eq } from 'drizzle-orm';
import type { InfraConfig } from '@sazuz/config';
import type { SettingsDocument } from '@sazuz/config/settings';
import {
  SandboxError,
  sandboxExecutionSchema,
  sandboxInputSchema,
  sandboxResultSchema,
  type SandboxInput,
  type SandboxResult,
} from '@sazuz/core/sandbox';
import {
  sandboxExecutions,
  missionContext,
  jsonValue,
  valueHash,
  workKey,
  projects,
  type Database,
} from '@sazuz/db';
import { defineTool, type ToolContext, type Verification } from '@sazuz/tools';
import { secretRedactor } from '@sazuz/vault';
import { missionLimitsSchema } from '@sazuz/core/missions';
import { z } from 'zod';
import { issueGrant } from './auth.js';
import { buildContainer, containerName } from './container.js';
import { dockerEngine, decodeLogs, waitContainer, type ContainerEngine } from './docker.js';

export interface SandboxOptions {
  database: Database;
  config: InfraConfig;
  getSettings: () => SettingsDocument;
  key: () => Promise<string>;
  engine?: (token: string) => ContainerEngine;
}
export function createSandboxService(options: SandboxOptions) {
  const { database, getSettings, config } = options;
  async function identity(context: ToolContext, args: SandboxInput, expiresAt: number) {
    const mission = await missionContext(database, context.runId);
    if (
      !mission ||
      mission.project.id !== context.projectId ||
      mission.run.agentId !== context.agentId ||
      !['running', 'queued'].includes(mission.run.status)
    )
      throw new SandboxError('SANDBOX_DENIED');
    const domains =
      getSettings().security.value.agentDomains.find((entry) => entry.agentId === context.agentId)
        ?.domains ?? [];
    if (args.network !== 'none' && !domains.length) throw new SandboxError('SANDBOX_DENIED');
    const key = await options.key();
    const name = containerName(context.idempotencyKey);
    const grant = {
      subject: name,
      projectId: context.projectId,
      agentId: context.agentId,
      domains: args.network === 'none' ? [] : domains,
      expiresAt: Math.max(Date.now() + 30_000, expiresAt + 15_000),
    };
    const token = issueGrant(key, { ...grant, service: 'docker' });
    const proxyToken =
      args.network === 'none'
        ? undefined
        : issueGrant(key, {
            ...grant,
            service: 'egress',
            expiresAt: Math.max(Date.now() + 1000, expiresAt),
          });
    secretRedactor.register(token);
    if (proxyToken) {
      secretRedactor.register(proxyToken);
      secretRedactor.register(Buffer.from(`sazuz:${proxyToken}`).toString('base64'));
    }
    return {
      name,
      engine: (options.engine ?? ((value) => dockerEngine(config, value)))(token),
      proxyToken,
    };
  }
  async function finish(
    row: typeof sandboxExecutions.$inferSelect,
    engine: ContainerEngine,
    signal: AbortSignal,
  ): Promise<SandboxResult> {
    const status = await waitContainer(engine, row.containerName, row.expiresAt.getTime(), signal);
    // Recover the original capability before reading output after a worker restart.
    const container = await engine.inspect(row.containerName);
    if (!container) throw new SandboxError('SANDBOX_UNCERTAIN');
    for (const entry of container.Config.Env ?? []) {
      if (!/^(?:HTTP_PROXY|HTTPS_PROXY|http_proxy|https_proxy)=/.test(entry)) continue;
      try {
        const token = decodeURIComponent(new URL(entry.slice(entry.indexOf('=') + 1)).password);
        if (token) {
          secretRedactor.register(token);
          secretRedactor.register(Buffer.from(`sazuz:${token}`).toString('base64'));
        }
      } catch {
        throw new SandboxError('SANDBOX_INVALID');
      }
    }
    const decoded = decodeLogs(await engine.logs(row.containerName));
    const result = sandboxResultSchema.parse({
      executionId: row.id,
      ...status,
      ...decoded,
      output: secretRedactor.redactText(decoded.output),
    });
    await database.orm
      .update(sandboxExecutions)
      .set({ status: 'done', result: jsonValue(result), updatedAt: new Date() })
      .where(eq(sandboxExecutions.id, row.id));
    try {
      await engine.remove(row.containerName);
    } catch {
      database.logger.warn(
        { code: 'SANDBOX_CLEANUP_PENDING', executionId: row.id },
        'The completed container will be cleaned up by the proxy.',
      );
    }
    return result;
  }
  async function verify(
    context: ToolContext,
    args: SandboxInput,
  ): Promise<Verification<SandboxResult>> {
    const [row] = await database.orm
      .select()
      .from(sandboxExecutions)
      .where(eq(sandboxExecutions.key, context.idempotencyKey));
    if (!row) return { status: 'not_done' };
    if (
      row.argsHash !== valueHash(args) ||
      row.runId !== context.runId ||
      row.projectId !== context.projectId
    )
      throw new SandboxError('SANDBOX_DENIED');
    if (row.status === 'done')
      return { status: 'done', result: sandboxResultSchema.parse(row.result) };
    const { engine } = await identity(context, args, row.expiresAt.getTime());
    const existing = await engine.inspect(row.containerName);
    if (!existing || existing.State.Status === 'created')
      return row.status === 'creating' ? { status: 'not_done' } : { status: 'unknown' };
    return { status: 'done', result: await finish(row, engine, context.signal) };
  }
  async function run(context: ToolContext, args: SandboxInput): Promise<SandboxResult> {
    const timeout = getSettings().sandbox.value.timeoutSeconds;
    let [row] = await database.orm
      .select()
      .from(sandboxExecutions)
      .where(eq(sandboxExecutions.key, context.idempotencyKey));
    const mission = await missionContext(database, context.runId);
    if (!mission) throw new SandboxError('SANDBOX_DENIED');
    const checkpoint = z
      .object({ loop: z.object({ startedAt: z.iso.datetime() }) })
      .safeParse(mission.run.checkpoint);
    const startedAt = checkpoint.success
      ? Date.parse(checkpoint.data.loop.startedAt)
      : mission.run.createdAt.getTime();
    const runDeadline =
      startedAt + missionLimitsSchema.parse(mission.run.limits).maxWallTimeSeconds * 1000;
    const expiresAt =
      row?.expiresAt.getTime() ?? Math.min(Date.now() + timeout * 1000, runDeadline);
    const connection = await identity(context, args, expiresAt);
    if (row) {
      const reconciled = await verify(context, args);
      if (reconciled.status === 'done') return reconciled.result;
      if (reconciled.status === 'unknown') throw new SandboxError('SANDBOX_UNCERTAIN');
    } else {
      [row] = await database.orm
        .insert(sandboxExecutions)
        .values({
          id: workKey('sbx'),
          runId: context.runId,
          projectId: context.projectId,
          agentId: context.agentId,
          key: context.idempotencyKey,
          argsHash: valueHash(args),
          containerName: connection.name,
          language: args.language,
          network: args.network,
          expiresAt: new Date(expiresAt),
        })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new SandboxError('SANDBOX_CONFLICT');
    }
    if (expiresAt <= Date.now()) throw new SandboxError('SANDBOX_UNCERTAIN');
    if (!(await connection.engine.inspect(connection.name)))
      await connection.engine.create(
        connection.name,
        buildContainer({
          args,
          projectId: context.projectId,
          runId: context.runId,
          key: context.idempotencyKey,
          expiresAt,
          settings: getSettings().sandbox.value,
          config,
          ...(connection.proxyToken ? { proxyToken: connection.proxyToken } : {}),
        }),
      );
    // Persist before start: a lost start acknowledgement is reconciled, never blindly restarted.
    await database.orm
      .update(sandboxExecutions)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(sandboxExecutions.id, row.id));
    await connection.engine.start(connection.name);
    return finish(row, connection.engine, context.signal);
  }
  return { run, verify };
}
export function createSandboxTools(service: ReturnType<typeof createSandboxService>) {
  return [
    defineTool({
      name: 'sandbox.run',
      description:
        'Run Python (pandas/matplotlib) or Node code in a hardened Docker container. Files use this project workspace. Network is off unless explicitly requested and granted in Settings. No host execution or secret injection. Review code and any admitted domains before approval.',
      input: sandboxInputSchema,
      output: sandboxResultSchema,
      effect: 'write',
      scope: 'external',
      untrusted: true,
      run: service.run,
      verify: service.verify,
    }),
  ];
}
export async function listSandboxExecutions(database: Database, userId: string) {
  const rows = await database.orm
    .select({ execution: sandboxExecutions })
    .from(sandboxExecutions)
    .innerJoin(projects, eq(projects.id, sandboxExecutions.projectId))
    .where(and(eq(projects.userId, userId)))
    .orderBy(desc(sandboxExecutions.createdAt))
    .limit(100);
  return rows.map(({ execution: row }) =>
    sandboxExecutionSchema.parse({
      id: row.id,
      runId: row.runId,
      projectId: row.projectId,
      agentId: row.agentId,
      language: row.language,
      network: row.network,
      status: row.status,
      result: row.result,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    }),
  );
}
