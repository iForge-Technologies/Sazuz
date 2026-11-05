import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@sazuz/core';
import { createDatabase } from '@sazuz/db';
import { freshSettings } from '@sazuz/config/settings';
import { secretRedactor } from '@sazuz/vault';
import { z } from 'zod';
import type { ModelRouter } from '../../packages/llm/src/router.js';
import type {
  GenerateRequest,
  GenerateResult,
  LlmToolCall,
} from '../../packages/llm/src/contracts.js';
import {
  createEmailTools,
  type ConnectorAccount,
  type MailTransport,
} from '../../packages/connectors/src/index.js';
import { ToolRegistry, ToolError, defineTool } from '../../packages/tools/src/index.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { createMissionQueue } from '../../packages/runtime/src/queue.js';
import { dedicatedDatabaseConfig } from './database-fixture.js';

export const fixtureMailAccount: ConnectorAccount = {
  id: 'runtime_mail',
  name: 'Acceptance mail',
  kind: 'email',
  provider: 'imap-smtp',
  mode: 'read-write',
  scopes: ['email:read', 'email:draft', 'email:send'],
  secretRef: 'secret://sec_00000000000000000000000001',
  options: {
    email: 'owner@example.test',
    imapHost: 'imap.example.test',
    smtpHost: 'smtp.example.test',
    sentMailbox: 'Sent',
  },
};
export const fixtureMailPassword = 'runtime-mail-fixture-password-4830629401';
export const fixtureEmail = {
  accountId: fixtureMailAccount.id,
  to: ['recipient@example.test'],
  cc: [],
  subject: 'Phase 3 acceptance',
  text: 'This message remains inside the test fixture.',
};

class FixtureBudgetError extends Error {
  readonly code = 'MODEL_BUDGET';
  constructor() {
    super('The deterministic model does not fit the remaining budget.');
  }
}

export function createFixtureRouter(
  options: {
    toolName?: string;
    args?: unknown;
    text?: string;
    costUsd?: number;
    plan?: unknown;
    onGenerate?: (request: GenerateRequest) => void;
  } = {},
): Pick<ModelRouter, 'generate' | 'generateObject'> {
  const generateResult = async (
    request: GenerateRequest,
    text: string,
    toolCalls: LlmToolCall[],
  ): Promise<GenerateResult> => {
    if (request.signal?.aborted) throw new Error('Fixture model was cancelled.');
    const costUsd = options.costUsd ?? 0;
    if (costUsd > request.remainingBudgetUsd + 1e-9) throw new FixtureBudgetError();
    options.onGenerate?.(request);
    const result: GenerateResult = {
      providerId: 'phase3_fixture',
      modelId: 'deterministic',
      text,
      toolCalls,
      finishReason: toolCalls.length ? 'tool-calls' : 'stop',
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, source: 'provider' },
      costUsd,
      costEstimated: false,
      latencyMs: 1,
    };
    await request.onUsage?.({
      providerId: result.providerId,
      modelId: result.modelId,
      usage: result.usage,
      costUsd,
      costEstimated: false,
      latencyMs: 1,
      status: 'completed',
    });
    return result;
  };
  return {
    async generate(request) {
      const completedTool = request.messages.some((message) => message.role === 'tool');
      const calls =
        options.toolName && !completedTool
          ? [{ id: 'fixture-call-1', name: options.toolName, args: options.args ?? {} }]
          : [];
      return generateResult(
        request,
        calls.length
          ? 'I will perform the requested action.'
          : (options.text ?? 'Fixture task completed.'),
        calls,
      );
    },
    async generateObject<T>(request: GenerateRequest, schema: z.ZodType<T>) {
      const object = schema.parse(
        options.plan ?? { tasks: [], deliverable: 'A concise fixture answer.' },
      );
      return { ...(await generateResult(request, JSON.stringify(object), [])), object };
    },
  };
}

const effectResultSchema = z.strictObject({ written: z.literal(true), value: z.string() });
export function createFixtureTools(
  options: { fixtureOrigin?: string; mail?: MailTransport; onRead?: () => void } = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: 'time.fixture_now',
      description: 'Read the deterministic acceptance clock.',
      input: z.strictObject({}),
      output: z.strictObject({ at: z.iso.datetime() }),
      effect: 'read',
      scope: 'internal',
      untrusted: false,
      run: () => {
        options.onRead?.();
        return Promise.resolve({ at: '2026-11-03T09:00:00.000Z' });
      },
    }),
  );
  if (options.fixtureOrigin) {
    const origin = new URL(options.fixtureOrigin);
    if (
      origin.protocol !== 'http:' ||
      origin.hostname !== '127.0.0.1' ||
      origin.username ||
      origin.password
    )
      throw new Error('The effect fixture must be a local test server.');
    registry.register(
      defineTool({
        name: 'files.fixture_write',
        description: 'Write to the local acceptance fixture.',
        input: z.strictObject({ value: z.string().min(1).max(1000) }),
        output: effectResultSchema,
        effect: 'write',
        scope: 'internal',
        untrusted: false,
        run: async (context, args) => {
          const url = new URL(`/effects/${encodeURIComponent(context.idempotencyKey)}`, origin);
          const response = await fetch(url, {
            method: 'POST',
            signal: context.signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(args),
          });
          if (!response.ok) throw new ToolError('TOOL_FAILED');
          return effectResultSchema.parse(await response.json());
        },
        verify: async (context) => {
          const response = await fetch(
            new URL(`/effects/${encodeURIComponent(context.idempotencyKey)}`, origin),
            { signal: context.signal },
          );
          if (!response.ok) {
            await response.body?.cancel();
            return { status: 'unknown' };
          }
          return { status: 'done', result: effectResultSchema.parse(await response.json()) };
        },
      }),
    );
  }
  if (options.mail)
    for (const tool of createEmailTools({
      getAccounts: () => [fixtureMailAccount],
      mail: options.mail,
    }))
      registry.register(tool);
  return registry;
}

async function runWorkerFixture(): Promise<void> {
  process.send?.({ kind: 'stage', name: 'database' });
  const input = z
    .strictObject({
      databaseUrl: z.string().min(1),
      fixtureOrigin: z.url(),
      dataDir: z.string().min(1),
    })
    .parse({
      databaseUrl: process.env['SAZUZ_TEST_DATABASE_URL'],
      fixtureOrigin: process.env['SAZUZ_PHASE3_FIXTURE_ORIGIN'],
      dataDir: process.env['SAZUZ_PHASE3_DATA_DIR'],
    });
  const config = dedicatedDatabaseConfig(input.databaseUrl);
  const logger = createLogger('phase3-runtime-child', secretRedactor, { write: () => undefined });
  const database = await createDatabase(config, logger, { maxConnections: 12 });
  const controller = new AbortController();
  const settings = freshSettings();
  settings.general.value.timezone = 'UTC';
  process.send?.({ kind: 'stage', name: 'queue' });
  const queue = await createMissionQueue(database);
  const executor = createDurableExecutor({
    database,
    workerId: 'phase3-runtime-child',
    dataDir: input.dataDir,
    getSettings: () => settings,
    tools: createFixtureTools({ fixtureOrigin: input.fixtureOrigin }),
    router: () =>
      createFixtureRouter({
        toolName: 'files.fixture_write',
        args: { value: 'durable fixture effect' },
      }),
    signal: controller.signal,
  });
  try {
    process.send?.({ kind: 'stage', name: 'recovery' });
    await queue.recover();
    process.send?.({ kind: 'stage', name: 'work' });
    await queue.work((runId) => executor.execute(runId));
    const stopped = new Promise<void>((resolve) => {
      process.on('message', (value: unknown) => {
        if (z.object({ kind: z.literal('stop') }).safeParse(value).success) resolve();
      });
      process.once('disconnect', resolve);
    });
    process.send?.({ kind: 'ready' });
    let stopping = false;
    void stopped.then(() => {
      stopping = true;
      controller.abort();
    });
    while (!stopping) {
      await queue.dispatch();
      await Promise.race([stopped, delay(100)]);
    }
  } finally {
    controller.abort();
    await queue.close();
    await database.close();
  }
}

if (process.env['SAZUZ_PHASE3_RUNTIME_WORKER'] === '1') {
  try {
    await runWorkerFixture();
    process.send?.({ kind: 'stopped' });
  } catch {
    process.send?.({ kind: 'failed' });
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect?.();
  }
}
