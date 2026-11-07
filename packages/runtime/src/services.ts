import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { readOperatorKey, type InfraConfig } from '@sazuz/config';
import type { SettingsDocument } from '@sazuz/config/settings';
import { modelCatalog, withActivity, type Database } from '@sazuz/db';
import { ModelRouter, configuredModel, modelInfoSchema, type GenerateRequest } from '@sazuz/llm';
import { createBuiltinTools, type SafeNetworkDependencies } from '@sazuz/tools';
import { createConnectorTools, pollImapAccount, type MailTransport } from '@sazuz/connectors';
import type { z } from 'zod';
import { createExecutionBroker, type ExecutionScope } from './broker.js';
import { createDurableExecutor } from './durable.js';
import { createMissionQueue } from './queue.js';
import { createAutomationRunner, expireApprovals } from './automation.js';
import { createNotificationRouter } from './notifications.js';
import { createTelegramService } from './telegram.js';
import { createChannelTool } from '@sazuz/channels';
import { RunSuspension } from './contracts.js';
import { agentActionPermission, createProviderAdmission } from '@sazuz/orchestrator';
import { agentRoleSchema } from '@sazuz/core/agents';
import { missionContext } from '@sazuz/db';
import {
  createMemoryTools,
  createKnowledgeWorker,
  enqueueExtraction,
  memoryContext,
  createKnowledgeTools,
} from '@sazuz/memory';
import { runEmbeddings } from './knowledge.js';
import { createSkillTools, ensureBuiltinSkills, skillsContext, styleContext } from '@sazuz/skills';
import { createSandboxService, createSandboxTools } from '@sazuz/sandbox';
import { createBrowserTools, workerBrowserTransport, workerBrowserImage } from '@sazuz/browser';
import { mcpTools, selectedMcp, workerExternalDispatch } from '@sazuz/mcp';
import { bridgeTools, selectedBridge } from '@sazuz/bridge';
import { tickS2aSchedules } from './s2a-scheduler.js';

export interface WorkerServiceOptions {
  database: Database;
  config: InfraConfig;
  workerId: string;
  getSettings: () => SettingsDocument;
  fetch?: typeof fetch;
  mail?: MailTransport;
  network?: SafeNetworkDependencies;
}

/** Independent bounded services keep slow feed polls away from approval resumes. */
export async function startWorkerServices(options: WorkerServiceOptions) {
  const { database, config, workerId, getSettings } = options;
  const controller = new AbortController();
  const { signal } = controller;
  const fetcher = options.fetch ?? fetch;
  const broker = createExecutionBroker(database, config, workerId, fetcher);
  const execution = new AsyncLocalStorage<{ scope: ExecutionScope; signal: AbortSignal }>();
  const router = new ModelRouter({
    admitProvider: createProviderAdmission(database, getSettings),
    getSettings: () => ({
      providers: getSettings().providers.value,
      models: getSettings().models.value,
    }),
    getCatalog: async () =>
      (await database.orm.select().from(modelCatalog)).map((row) =>
        configuredModel(modelInfoSchema.parse(row.value), getSettings().models.value),
      ),
    resolveSecret: (reference, consume) => {
      const current = execution.getStore();
      if (!current) throw new RunSuspension('paused', 'An active execution scope is required.');
      return broker.secret(reference, current.scope, consume, current.signal);
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const tools = createBuiltinTools();
  const sandbox = createSandboxService({
    database,
    config,
    getSettings,
    key: () => readOperatorKey(config.dataDir),
  });
  for (const tool of createSandboxTools(sandbox)) tools.register(tool);
  for (const tool of createBrowserTools(
    workerBrowserTransport({
      config,
      workerId,
      key: () => readOperatorKey(config.dataDir),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  ))
    tools.register(tool);
  await ensureBuiltinSkills(database);
  const embeddings = runEmbeddings({
    database,
    workerId,
    getSettings,
    embed: (scope, request) =>
      execution.run({ scope, signal: request.signal ?? signal }, () => router.embed(request)),
  });
  for (const tool of [
    ...createMemoryTools(database, embeddings),
    ...createKnowledgeTools(database, embeddings),
    ...createSkillTools(database),
  ])
    tools.register(tool);
  for (const tool of createConnectorTools({
    getAccounts: () => getSettings().connectors.value.accounts,
    authorizeAccount: async (context, account, _permission, action) => {
      const mission = await missionContext(database, context.runId);
      if (!mission) return false;
      return agentActionPermission(
        database,
        mission.project.userId,
        context.runId,
        agentRoleSchema.parse(context.agentId),
        action.name,
        { accountId: account.id },
        action.effect,
        getSettings().connectors.value.accounts,
      );
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.mail ? { mail: options.mail } : {}),
  }))
    tools.register(tool);
  const executor = createDurableExecutor({
    database,
    workerId,
    dataDir: config.dataDir,
    getSettings,
    tools,
    signal,
    dynamicTools: async (runId, agentId) => {
      const selected = await selectedMcp(database, runId, true);
      const dispatch = workerExternalDispatch({
        config,
        workerId,
        key: () => readOperatorKey(config.dataDir),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      const dynamic = [
        ...mcpTools(selected, agentId, dispatch),
        ...bridgeTools(await selectedBridge(database, runId, true), agentId, dispatch),
      ];
      return {
        tools: [
          ...dynamic,
          createChannelTool(async (ctx) => {
            const current = await missionContext(database, ctx.runId);
            if (current?.run.claimKey && current.run.workerId === workerId)
              return broker.channel(
                {
                  runId: ctx.runId,
                  claimKey: current.run.claimKey,
                  scope: 'tool',
                  executionId: ctx.idempotencyKey,
                },
                ctx.signal,
              );
            throw new RunSuspension('paused', 'The channel action has no execution scope.');
          }),
        ],
        tainted: dynamic.length > 0,
      };
    },
    ...(options.network ? { network: options.network } : {}),
    complete: enqueueExtraction,
    buildContext: async (input, messages) => {
      const memory = await memoryContext(database, input, messages, embeddings(input));
      const skills = await skillsContext(database, input.userId, memory.messages);
      const style = await styleContext(database, input, skills.messages);
      return {
        messages: style.messages,
        tainted: memory.tainted || skills.tainted || style.tainted,
        privateOnly: memory.privateOnly || style.privateOnly,
      };
    },
    ready: (scope, abortSignal) => broker.ready(scope, abortSignal),
    browserImage: workerBrowserImage({
      config,
      workerId,
      key: () => readOperatorKey(config.dataDir),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
    secret: (reference, scope, consume, abortSignal) =>
      broker.secret(reference, scope, consume, abortSignal),
    onToken: async (runId, text, step) => {
      const characters = [...text];
      for (let offset = 0; offset < characters.length; offset += 800)
        await database.pool.query('SELECT pg_notify($1,$2)', [
          'run_token',
          JSON.stringify({ runId, step, text: characters.slice(offset, offset + 800).join('') }),
        ]);
    },
    router: (scope) => ({
      generate: (request) =>
        execution.run({ scope, signal: request.signal ?? signal }, () => router.generate(request)),
      generateObject: <T>(
        request: GenerateRequest,
        schema: z.ZodType<T>,
        options?: { maxAttempts?: 1 | 2 },
      ) =>
        execution.run({ scope, signal: request.signal ?? signal }, () =>
          router.generateObject(request, schema, options),
        ),
    }),
  });
  const telegram = createTelegramService({
    database,
    getSettings,
    tools,
    signal,
    secret: (reference, scope, consume, abortSignal) =>
      broker.secret(reference, scope, consume, abortSignal),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const notificationRouter = createNotificationRouter({
    database,
    getSettings,
    deliver: telegram.deliver,
    classifier: {
      workerId,
      router: (scope) => ({
        generateObject: <T>(
          request: GenerateRequest,
          schema: z.ZodType<T>,
          options?: { maxAttempts?: 1 | 2 },
        ) =>
          execution.run({ scope, signal: request.signal ?? signal }, () =>
            router.generateObject(request, schema, options),
          ),
      }),
    },
  });
  const automation = createAutomationRunner({
    database,
    getSettings,
    signal,
    ...(options.network ? { network: options.network } : {}),
    listImap: (request, triggerId) => {
      const account = getSettings().connectors.value.accounts.find(
        (item) => item.id === request.connectorId,
      );
      if (!account) throw new RunSuspension('paused', 'The trigger connector is unavailable.');
      return pollImapAccount(
        account,
        {
          signal: request.signal,
          secret: (reference, consume) =>
            broker.secret(
              reference,
              { scope: 'trigger', executionId: triggerId, runId: null, claimKey: null },
              consume,
              request.signal,
            ),
        },
        {
          mailbox: request.mailbox,
          afterUid: request.afterUid,
          uidValidity: request.uidValidity,
          limit: request.limit,
        },
        options.mail,
      );
    },
  });
  const queue = await createMissionQueue(database);
  try {
    await queue.recover();
    await queue.work(async (runId) => {
      // Auto-mode restarts may bring the worker up before the vault server. Leave queued work recoverable.
      let reachable = false;
      try {
        const response = await fetcher(new URL('/api/health', config.serverUrl), {
          signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
          redirect: 'error',
        });
        reachable = response.ok;
        await response.body?.cancel();
      } catch {
        if (!signal.aborted)
          database.logger.warn(
            { code: 'EXECUTION_SERVER_UNAVAILABLE' },
            'Queued missions are waiting for the server.',
          );
      }
      if (reachable && !signal.aborted) await withActivity(database, () => executor.execute(runId));
    });
  } catch (error) {
    await queue.close();
    throw error;
  }
  const tasks: Promise<void>[] = [];
  const knowledge = createKnowledgeWorker({
    database,
    workerId,
    getSettings,
    signal,
    ...(options.network ? { network: options.network } : {}),
    ready: (scope, abortSignal) => broker.ready(scope, abortSignal),
    router: (scope) => ({
      embed: (request) =>
        execution.run({ scope, signal: request.signal ?? signal }, () => router.embed(request)),
      generate: (request) =>
        execution.run({ scope, signal: request.signal ?? signal }, () => router.generate(request)),
      generateObject: <T>(
        request: GenerateRequest,
        schema: z.ZodType<T>,
        options?: { maxAttempts?: 1 | 2 },
      ) =>
        execution.run({ scope, signal: request.signal ?? signal }, () =>
          router.generateObject(request, schema, options),
        ),
    }),
  });
  function start(name: string, milliseconds: number, task: () => Promise<void>) {
    const running = (async () => {
      while (!signal.aborted) {
        try {
          await withActivity(database, task);
        } catch {
          if (!signal.aborted)
            database.logger.error(
              { code: 'WORKER_SERVICE_RETRY', service: name },
              'A background service will retry; durable work remains in PostgreSQL.',
            );
        }
        if (signal.aborted) break;
        try {
          await delay(milliseconds, undefined, { signal });
        } catch {
          if (!signal.aborted) throw new Error('Background service scheduling failed.');
        }
      }
    })();
    tasks.push(running);
  }
  start('queue-dispatch', 300, queue.dispatch);
  start('queue-recovery', 2000, queue.recover);
  start('knowledge', 1500, knowledge.tick);
  start('triggers', 1000, () => automation.tick());
  start('s2a-schedules', 1000, () => tickS2aSchedules(database, getSettings));
  start('notifications', 1000, async () => {
    await expireApprovals(database);
    await notificationRouter.tick();
  });
  start('telegram', 200, telegram.poll);
  return {
    queue,
    async close() {
      controller.abort();
      try {
        await Promise.all(tasks);
      } finally {
        await queue.close();
      }
    },
  };
}
