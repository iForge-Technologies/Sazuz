import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { ulid } from 'ulid';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ModelRouter, configuredModel } from '@sazuz/llm';
import { modelInfoSchema, modelPriceSchema, type LlmMessage } from '@sazuz/llm/contracts';
import { createBuiltinTools, renderToolOutput } from '@sazuz/tools';
import { evaluatePolicy } from '@sazuz/policy';
import { newCheckpoint, runAgent, SYSTEM_RULES } from '@sazuz/runtime';
import { secretRedactor, type SecretReference } from '@sazuz/vault';
import {
  addMessage,
  auditLog,
  costTotals,
  createProject,
  createThread,
  listProjects,
  listThreads,
  messages,
  modelCatalog,
  publicMessage,
  readMessages,
  recordCost,
  remainingSpend,
  saveSetting,
  threadContext,
} from '@sazuz/db';
import { chatInput, projectInput, threadInput, workId, type ChatEvent } from '@sazuz/core/work';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { RequestError } from './phase-one-errors.js';
import { createProviderAdmission } from '@sazuz/orchestrator';
import type { ChatHandler } from './phase-three-chat.js';

const empty = z.strictObject({});
const pathId = z.strictObject({ id: workId });
const providerPath = z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) });
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new RequestError('INVALID_REQUEST', 400, 'Check the submitted fields.');
  return parsed.data;
}

export function createModelServices(runtime: PhaseOne, overrides: { fetch?: typeof fetch } = {}) {
  const { database } = runtime;
  const catalog = async () =>
    (await database.orm.select().from(modelCatalog)).map((row) =>
      configuredModel(modelInfoSchema.parse(row.value), runtime.settings.models.value),
    );
  const router = new ModelRouter({
    admitProvider: createProviderAdmission(database, () => runtime.settings),
    getSettings: () => ({
      providers: runtime.settings.providers.value,
      models: runtime.settings.models.value,
    }),
    getCatalog: catalog,
    resolveSecret: (reference, consume) =>
      runtime.vault.withSecret(reference as SecretReference, 'user', consume),
    ...overrides,
  });
  return { router, catalog, tools: createBuiltinTools() };
}
export type ModelServices = ReturnType<typeof createModelServices>;

export function registerPhaseTwo(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  services = createModelServices(runtime),
  options: { chat?: ChatHandler } = {},
) {
  const { database } = runtime;
  app.get('/api/projects', async (request) => {
    parse(empty, request.query);
    const { user } = await runtime.admin(request);
    return listProjects(database, user.id);
  });
  app.post('/api/projects', async (request) => {
    const { user } = await runtime.admin(request);
    return createProject(database, user.id, parse(projectInput, request.body));
  });
  app.get('/api/threads', async (request) => {
    const { user } = await runtime.admin(request);
    const { projectId } = parse(z.strictObject({ projectId: workId }), request.query);
    return listThreads(database, user.id, projectId);
  });
  app.post('/api/threads', async (request) => {
    const { user } = await runtime.admin(request);
    const row = await createThread(database, user.id, parse(threadInput, request.body));
    if (!row) throw new RequestError('NOT_FOUND', 404, 'Project unavailable.');
    return row;
  });
  app.get('/api/threads/:id/messages', async (request) => {
    const { user } = await runtime.admin(request);
    const { id } = parse(pathId, request.params);
    parse(empty, request.query);
    if (!(await threadContext(database, user.id, id)))
      throw new RequestError('NOT_FOUND', 404, 'Thread unavailable.');
    return (await readMessages(database, id)).map(publicMessage);
  });
  app.get('/api/providers', async (request) => {
    await runtime.admin(request);
    parse(empty, request.query);
    return runtime.settings.providers.value.items;
  });
  app.get('/api/models', async (request) => {
    await runtime.admin(request);
    parse(empty, request.query);
    return services.catalog();
  });
  app.post('/api/providers/:id/discover', async (request) => {
    await runtime.admin(request);
    const { id } = parse(providerPath, request.params);
    parse(empty, request.body);
    let discovered;
    try {
      discovered = await services.router.discover(id);
    } catch {
      throw new RequestError(
        'PROVIDER_UNAVAILABLE',
        502,
        'Model discovery failed. Check the endpoint, credentials, and vault.',
      );
    }
    await database.orm.transaction(async (tx) => {
      await tx.delete(modelCatalog).where(eq(modelCatalog.providerId, id));
      for (const model of discovered)
        await tx.insert(modelCatalog).values({ providerId: id, modelId: model.id, value: model });
    });
    return { models: (await services.catalog()).filter((model) => model.providerId === id) };
  });
  app.post('/api/providers/:id/test', async (request) => {
    await runtime.admin(request);
    const { id } = parse(providerPath, request.params);
    const { modelId } = parse(
      z.strictObject({ modelId: z.string().min(1).max(200).optional() }),
      request.body,
    );
    if (!modelId) return services.router.health(id);
    await runtime.rateLimit('model-test', 10);
    const lease = await database.pool.connect();
    try {
      const owned = await lease.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(72839102) AS locked',
      );
      if (!owned.rows[0]?.locked)
        throw new RequestError('RUN_BUSY', 409, 'Another run is active. Wait for it to finish.');
      const budgets = runtime.settings.budgets.value;
      const generated = await services.router.testModel(id, modelId, {
        remainingBudgetUsd: Math.max(
          0,
          Math.min(budgets.perRunUsd, await remainingSpend(database, budgets)),
        ),
        signal: AbortSignal.timeout(30_000),
        onUsage: (record) =>
          recordCost(database, {
            id: `cost_${ulid()}`,
            agentId: 'model-test',
            providerId: record.providerId,
            modelId: record.modelId,
            inputTokens: record.usage.inputTokens,
            outputTokens: record.usage.outputTokens,
            cachedInputTokens: record.usage.cachedInputTokens,
            costUsd: record.costUsd,
            estimated: record.costEstimated,
            latencyMs: record.latencyMs,
            status: record.status,
          }),
      });
      return {
        providerId: id,
        ok: true,
        code: 'READY',
        modelCount: 1,
        latencyMs: generated.latencyMs,
      };
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(
        'MODEL_TEST_FAILED',
        502,
        'Model generation failed. Check model selection, price, budget, endpoint, credentials, and vault.',
      );
    } finally {
      await lease
        .query('SELECT pg_advisory_unlock(72839102)')
        .catch(() =>
          database.logger.warn(
            { code: 'RUN_LEASE_RELEASE_FAILED' },
            'Model test lease connection closed.',
          ),
        );
      lease.release();
    }
  });
  app.put('/api/models/prices', async (request) => {
    const { user } = await runtime.admin(request);
    const body = parse(
      z.strictObject({
        providerId: z.string().min(1).max(64),
        modelId: z.string().min(1).max(200),
        price: modelPriceSchema,
      }),
      request.body,
    );
    const current = runtime.settings.models;
    await saveSetting(database, {
      namespace: 'models',
      expectedVersion: current.version,
      actorId: user.id,
      value: {
        ...current.value,
        priceOverrides: [
          ...current.value.priceOverrides.filter(
            (entry) => entry.providerId !== body.providerId || entry.modelId !== body.modelId,
          ),
          body,
        ],
      },
    });
    return { ok: true };
  });
  app.get('/api/costs', async (request) => {
    await runtime.admin(request);
    parse(empty, request.query);
    return costTotals(database);
  });
  const legacyChat: ChatHandler = async (request, reply) => {
    const { user } = await runtime.admin(request);
    const { id } = parse(pathId, request.params);
    const body = parse(chatInput, request.body);
    const context = await threadContext(database, user.id, id);
    if (!context) throw new RequestError('NOT_FOUND', 404, 'Thread unavailable.');
    if ((await runtime.vault.status()).locked)
      throw new RequestError('VAULT_LOCKED', 423, 'Unlock the vault to use models.');
    await runtime.rateLimit('chat', 20);
    // One inference owner avoids overlapping turns and overspending shared caps in this phase.
    const lease = await database.pool.connect();
    const owned = await lease.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(72839102) AS locked',
    );
    if (!owned.rows[0]?.locked) {
      lease.release();
      throw new RequestError('RUN_BUSY', 409, 'Another run is active. Wait for it to finish.');
    }
    const signal = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) signal.abort();
    });
    let ended = false;
    const emit = (event: ChatEvent) => {
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      return Promise.resolve();
    };
    try {
      const existing = await database.orm
        .select()
        .from(messages)
        .where(and(eq(messages.threadId, id), eq(messages.requestId, body.requestId)));
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders()))
        if (value !== undefined) reply.raw.setHeader(name, value);
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      });
      if (existing.length) {
        await emit({
          type: 'run.status',
          status: 'completed',
          message: 'This request was already accepted. Refresh to see the saved messages.',
        });
        return;
      }
      const runId = `run_${ulid()}`;
      const workspaceDir = join(runtime.config.dataDir, 'workspace', context.project.id);
      await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
      const userRow = await addMessage(database, {
        id: `msg_${ulid()}`,
        threadId: id,
        role: 'user',
        content: body.content,
        requestId: body.requestId,
      });
      if (!userRow)
        throw new RequestError('RUN_DUPLICATE', 409, 'This message was already submitted.');
      const history = await readMessages(database, id);
      const llmMessages: LlmMessage[] = [
        {
          role: 'system',
          content: `${SYSTEM_RULES}\nProject brief: ${secretRedactor.redactText(context.project.brief)}\nUser prefers ${runtime.settings.profile.value.tone} replies.`,
        },
      ];
      for (const row of history) {
        const publicRow = publicMessage(row);
        if (row.role === 'user')
          llmMessages.push({ role: 'user', content: secretRedactor.redactText(row.content) });
        if (row.role === 'assistant')
          llmMessages.push({
            role: 'assistant',
            content: row.content,
            ...(publicRow.toolCalls.length ? { toolCalls: publicRow.toolCalls } : {}),
          });
        if (row.role === 'tool' && row.toolCallId && row.toolName)
          llmMessages.push({
            role: 'tool',
            toolCallId: row.toolCallId,
            name: row.toolName,
            content: row.content,
          });
      }
      const limits = runtime.settings.budgets.value;
      let turnSpend = 0;
      const result = await runAgent({
        checkpoint: newCheckpoint(
          llmMessages,
          history.some((row) => row.trust === 'untrusted'),
        ),
        limits: {
          maxSteps: limits.maxSteps,
          maxCostUsd: limits.perRunUsd,
          maxWallTimeSeconds: limits.maxWallTimeSeconds,
        },
        tools: services.tools,
        context: {
          workspaceDir,
          projectId: context.project.id,
          runId,
          agentId: 'cos',
          idempotencyKey: '',
          signal: signal.signal,
        },
        privateOnly: context.project.privacy === 'private',
        remainingBudget: async () =>
          Math.min(
            limits.perRunUsd - turnSpend,
            await remainingSpend(database, limits, context.project.id, context.project.budgetUsd),
          ),
        generate: async (request) => {
          let requestSpend = 0;
          const generated = await services.router.generate({
            ...request,
            onUsage: async (record) => {
              requestSpend += record.costUsd;
              turnSpend += record.costUsd;
              await recordCost(database, {
                id: `cost_${ulid()}`,
                projectId: context.project.id,
                threadId: id,
                runId,
                agentId: 'cos',
                providerId: record.providerId,
                modelId: record.modelId,
                inputTokens: record.usage.inputTokens,
                outputTokens: record.usage.outputTokens,
                cachedInputTokens: record.usage.cachedInputTokens,
                costUsd: record.costUsd,
                estimated: record.costEstimated,
                latencyMs: record.latencyMs,
                status: record.status,
              });
            },
          });
          return { ...generated, costUsd: requestSpend };
        },
        authorize: async (call, tool, state) => {
          const decision = evaluatePolicy({
            tool: call.name,
            effect: tool.effect,
            effectKnown: tool.effectKnown,
            scope: tool.scope,
            agentId: 'cos',
            projectId: context.project.id,
            tainted: state.tainted,
            preset: runtime.settings.security.value.preset,
          });
          await database.orm.insert(auditLog).values({
            id: `aud_${ulid()}`,
            actorId: user.id,
            action: `policy.${decision.action}`,
            target: `${runId}:${call.name}:${decision.ruleId}`,
          });
          return decision;
        },
        save: async () => {},
        onToken: async (text) => emit({ type: 'text.delta', text }),
        onCall: async (call) => emit({ type: 'tool.call', ...call }),
        onAssistant: async (generated, state) => {
          const row = await addMessage(database, {
            id: `msg_${ulid()}`,
            threadId: id,
            role: 'assistant',
            content: generated.text,
            providerId: generated.providerId,
            modelId: generated.modelId,
            inputTokens: generated.usage.inputTokens,
            outputTokens: generated.usage.outputTokens,
            costUsd: generated.costUsd,
            usageEstimated: generated.costEstimated,
            toolCalls: generated.toolCalls,
            requestId: `${runId}:${state.step}`,
          });
          if (row) await emit({ type: 'message.completed', message: publicMessage(row) });
        },
        onTool: async (call, output, status, state) => {
          await addMessage(database, {
            id: `msg_${ulid()}`,
            threadId: id,
            role: 'tool',
            content: renderToolOutput(output),
            trust: output.untrusted ? 'untrusted' : 'trusted',
            toolCallId: call.id,
            toolName: call.name,
            requestId: `${runId}:${state.step}:${state.nextCall}`,
          });
          await emit({
            type: 'tool.result',
            id: call.id,
            name: call.name,
            output: output.output,
            status,
          });
        },
      });
      await emit({
        type: 'run.status',
        status: result.status,
        ...(result.reason ? { message: result.reason } : {}),
      });
      ended = true;
    } catch {
      if (reply.sent)
        await emit({
          type: 'run.status',
          status: 'failed',
          message:
            'The run stopped safely. Review model settings and saved messages before retrying.',
        });
      else throw new RequestError('RUN_FAILED', 503, 'The run could not start.');
    } finally {
      if (!ended) signal.abort();
      if (reply.sent && !reply.raw.writableEnded) reply.raw.end();
      await lease
        .query('SELECT pg_advisory_unlock(72839102)')
        .catch(() =>
          database.logger.warn(
            { code: 'RUN_LEASE_RELEASE_FAILED' },
            'Run lease connection closed.',
          ),
        );
      lease.release();
    }
  };
  app.post('/api/threads/:id/chat', options.chat ?? legacyChat);
  return services;
}
