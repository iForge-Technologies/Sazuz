import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { z } from 'zod';
import {
  createDatabase,
  createMission,
  createProject,
  migrateDatabase,
  missionContext,
  modelCatalog,
  recordHeartbeat,
  removeHeartbeat,
  runs,
  saveSetting,
  workKey,
} from '@sazuz/db';
import type { SettingsNamespace, SettingsValues } from '@sazuz/config/settings';
import { executionRequestSchema } from '@sazuz/vault';
import { createApp } from '../../apps/server/src/app.js';
import { createPhaseOne } from '../../apps/server/src/phase-one.js';
import { registerPhaseOne } from '../../apps/server/src/phase-one-routes.js';
import { registerPhaseTwo } from '../../apps/server/src/phase-two.js';
import { createPhaseThreeServices, registerPhaseThree } from '../../apps/server/src/phase-three.js';
import { startHeartbeat } from '../../apps/worker/src/heartbeat.js';
import type { MailTransport } from '../../packages/connectors/src/mail.js';
import type { TelegramUpdate } from '../../packages/channels/src/contracts.js';
import { openaiText, sse } from '../../packages/llm/src/test-fixtures.js';
import { startWorkerServices } from '../../packages/runtime/src/services.js';
import { MISSION_QUEUE } from '../../packages/runtime/src/queue.js';
import { openIntegrationDatabase } from './database-fixture.js';

const modelRequestSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
  response_format: z.unknown().optional(),
  tools: z
    .array(z.object({ function: z.object({ name: z.string(), description: z.string() }) }))
    .optional(),
});
export const workerPassphrase = 'worker-fixture-vault-passphrase-748210';
export const fixtureSecrets = {
  provider: 'sk-worker-service-fixture-192837465',
  mail: 'worker-mail-fixture-password-592810',
  telegram: '987654321:worker-service-fixture-token-592819',
};
export const fixtureSender = 12345678;
export const fixtureBot = '987654321';

/** Real repositories, vault, broker, adapters and worker services; only external transports are fixtures. */
export async function openWorkerFixture() {
  const prerequisite = await openIntegrationDatabase();
  const database = await createDatabase(prerequisite.config, prerequisite.logger, {
    maxConnections: 16,
  });
  await migrateDatabase(database);
  const occupied = await database.pool.query<{ count: number }>(
    'SELECT ((SELECT count(*) FROM installation)+(SELECT count(*) FROM users)+(SELECT count(*) FROM worker_heartbeats)+(SELECT count(*) FROM cost_ledger))::int AS count',
  );
  if (occupied.rows[0]?.count !== 0) {
    await database.close();
    await prerequisite.close();
    throw new Error('Worker service acceptance requires an empty dedicated test database.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'sazuz-phase3-services-'));
  const config = { ...prerequisite.config, dataDir: directory, serverUrl: 'http://127.0.0.1:7778' };
  const runtime = await createPhaseOne(database, config);
  const app = await createApp({
    logger: prerequisite.logger,
    health: () =>
      Promise.resolve({
        status: 'ok',
        checkedAt: new Date().toISOString(),
        services: {
          database: { status: 'ok', latencyMs: 1 },
          worker: { status: 'ok', activeCount: 1, lastSeenAt: new Date().toISOString() },
        },
      }),
  });
  let heartbeat: Awaited<ReturnType<typeof startHeartbeat>> | undefined;
  let worker: Awaited<ReturnType<typeof startWorkerServices>> | undefined;
  try {
    const cookies = new Map<string, string>();
    async function request(
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: string,
      payload?: unknown,
    ) {
      const response = await app.inject({
        method,
        url,
        headers: {
          origin: 'http://localhost:7777',
          'content-type': 'application/json',
          cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
      for (const cookie of response.cookies) cookies.set(cookie.name, cookie.value);
      return response;
    }
    registerPhaseOne(app, runtime);
    const services = createPhaseThreeServices(runtime);
    registerPhaseTwo(app, runtime, services);
    registerPhaseThree(app, runtime, services);
    const token = (await readFile(join(directory, 'secrets/setup-token'), 'utf8')).trim();
    expect((await request('POST', '/api/setup/gate', { token })).statusCode).toBe(200);
    expect(
      (
        await request('POST', '/api/setup/admin', {
          name: 'Worker fixture owner',
          email: 'worker-fixture@example.test',
          password: 'Worker-admin-password-728910',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request('POST', '/api/auth/sign-in/email', {
          email: 'worker-fixture@example.test',
          password: 'Worker-admin-password-728910',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request('POST', '/api/vault/initialize', {
          passphrase: workerPassphrase,
          mode: 'strict',
        })
      ).statusCode,
    ).toBe(200);
    const userId = (await runtime.state()).adminId!;
    const references = {
      provider: (
        await runtime.vault.create({
          name: 'Fixture provider',
          value: fixtureSecrets.provider,
          createdBy: userId,
        })
      ).reference,
      mail: (
        await runtime.vault.create({
          name: 'Fixture mail',
          value: fixtureSecrets.mail,
          createdBy: userId,
        })
      ).reference,
      telegram: (
        await runtime.vault.create({
          name: 'Fixture Telegram',
          value: fixtureSecrets.telegram,
          createdBy: userId,
        })
      ).reference,
    };
    async function setting<N extends SettingsNamespace>(namespace: N, value: SettingsValues[N]) {
      const current = runtime.settings[namespace];
      await saveSetting(database, {
        namespace,
        value,
        expectedVersion: current.version,
        actorId: userId,
      });
      await vi.waitFor(() => expect(runtime.settings[namespace].version).toBe(current.version + 1));
    }
    await setting('providers', {
      items: [
        {
          id: 'worker-fixture',
          name: 'Worker protocol fixture',
          kind: 'openai-compatible',
          baseUrl: 'https://worker-model.example.test/v1',
          secretRef: references.provider,
          locality: 'local',
          enabled: true,
        },
      ],
    });
    const selection = { providerId: 'worker-fixture', modelId: 'fixture-model' };
    await setting('models', {
      ...runtime.settings.models.value,
      roles: {
        ...runtime.settings.models.value.roles,
        planner: selection,
        executor: selection,
        fast: selection,
        vision: selection,
      },
    });
    await database.orm.insert(modelCatalog).values({
      ...selection,
      value: {
        id: selection.modelId,
        providerId: selection.providerId,
        name: 'Worker fixture',
        contextWindow: 32000,
        maxOutput: 4096,
        supports: { tools: true, vision: false, json: true, caching: false, reasoning: false },
        price: { inputPerMTok: 0, outputPerMTok: 0 },
        locality: 'local',
      },
    });
    await setting('connectors', {
      accounts: [
        {
          id: 'mail',
          name: 'Fixture mailbox',
          kind: 'email',
          provider: 'imap-smtp',
          secretRef: references.mail,
          scopes: ['email:read', 'email:send'],
          mode: 'read-write',
          options: {
            email: 'owner@example.test',
            imapHost: 'mail.example.test',
            smtpHost: 'mail.example.test',
          },
        },
      ],
    });
    const project = await createProject(database, userId, {
      name: 'Worker service acceptance',
      privacy: 'private',
      budgetUsd: 10,
    });
    const workerId = workKey('wrk');
    heartbeat = await startHeartbeat({
      logger: prerequisite.logger,
      write: () => recordHeartbeat(database, workerId),
      remove: () => removeHeartbeat(database, workerId),
      intervalMs: 1000,
    });
    const executionRequests: z.infer<typeof executionRequestSchema>[] = [];
    const modelRequests: z.infer<typeof modelRequestSchema>[] = [];
    const updates: TelegramUpdate[] = [];
    const telegramMessages: { text: string; chatId: string }[] = [];
    const offsets: number[] = [];
    const credentials: boolean[] = [];
    const mailPolls: number[] = [];
    const sent: string[] = [];
    let healthReady = true;
    let pollAvailable = true;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === config.serverUrl) {
        if (url.pathname === '/api/health' && !healthReady)
          throw new Error('Fixture server temporarily unavailable.');
        if (url.pathname === '/internal/execution')
          executionRequests.push(
            executionRequestSchema.parse(JSON.parse(z.string().parse(init?.body))),
          );
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => {
          headers[key] = value;
        });
        const response = await app.inject({
          method: z.enum(['GET', 'POST']).parse(init?.method ?? 'GET'),
          url: url.pathname,
          headers,
          ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
        });
        expect(
          response.body.includes(fixtureSecrets.provider) ||
            response.body.includes(fixtureSecrets.mail) ||
            response.body.includes(fixtureSecrets.telegram),
        ).toBe(false);
        return new Response(response.body, {
          status: response.statusCode,
          headers: {
            'content-type': String(response.headers['content-type'] ?? 'application/json'),
          },
        });
      }
      if (url.origin === 'https://worker-model.example.test') {
        credentials.push(
          new Headers(init?.headers).get('authorization') === `Bearer ${fixtureSecrets.provider}`,
        );
        const body = modelRequestSchema.parse(JSON.parse(z.string().parse(init?.body)));
        modelRequests.push(body);
        if (body.response_format)
          return sse(
            openaiText([JSON.stringify({ tasks: [], deliverable: 'A verified worker response.' })]),
          );
        const wantsMail = body.messages.some(
          (message) =>
            message.role === 'user' && String(message.content).includes('Read the fixture email'),
        );
        if (wantsMail && !body.messages.some((message) => message.role === 'tool')) {
          const tool = body.tools?.find((entry) =>
            entry.function.description.startsWith('email.read:'),
          );
          if (!tool) throw new Error('The Comms email tool was unavailable.');
          return sse([
            {
              id: 'worker-mail',
              model: selection.modelId,
              created: 1,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'worker-mail-call',
                        type: 'function',
                        function: {
                          name: tool.function.name,
                          arguments: JSON.stringify({ accountId: 'mail', uid: 1 }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
              usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
            },
          ]);
        }
        return sse(openaiText(['Worker fixture ', 'completed.']));
      }
      if (url.origin === 'https://api.telegram.org') {
        credentials.push(url.pathname.startsWith(`/bot${fixtureSecrets.telegram}/`));
        const method = url.pathname.split('/').at(-1);
        if (method === 'getMe')
          return Response.json({ ok: true, result: { id: Number(fixtureBot), is_bot: true } });
        const body: unknown = JSON.parse(z.string().parse(init?.body));
        if (method === 'getUpdates') {
          if (!pollAvailable) throw new Error('Fixture Telegram temporarily unavailable.');
          const { offset } = z.object({ offset: z.number().default(0) }).parse(body);
          offsets.push(offset);
          return Response.json({
            ok: true,
            result: updates.filter((update) => update.update_id >= offset),
          });
        }
        if (method === 'sendMessage') {
          const message = z.object({ text: z.string(), chat_id: z.string() }).parse(body);
          telegramMessages.push({ text: message.text, chatId: message.chat_id });
          return Response.json({
            ok: true,
            result: { message_id: telegramMessages.length, chat: { id: Number(message.chat_id) } },
          });
        }
        if (method === 'answerCallbackQuery') return Response.json({ ok: true, result: true });
      }
      throw new Error('The worker attempted an endpoint outside its fixture transports.');
    };
    const mailboxMessage = {
      uid: 1,
      subject: 'Fixture update',
      from: 'sender@example.test',
      text: 'An external fixture observation.',
      receivedAt: '2026-11-03T09:00:00Z',
    };
    const mail: MailTransport = {
      list: (input) => {
        credentials.push(input.password === fixtureSecrets.mail);
        mailPolls.push(input.afterUid ?? 0);
        return Promise.resolve({
          uidValidity: '17',
          messages: (input.afterUid ?? 0) < 1 ? [mailboxMessage] : [],
          hasMore: false,
          scannedThrough: 1,
        });
      },
      read: (input) => {
        credentials.push(input.password === fixtureSecrets.mail);
        return Promise.resolve(mailboxMessage);
      },
      send: (input) => {
        credentials.push(input.password === fixtureSecrets.mail);
        sent.push(input.messageId);
        return Promise.resolve({
          messageId: input.messageId,
          accepted: input.message.to,
          rejected: [],
        });
      },
      findSent: () => Promise.resolve(null),
    };
    async function stop() {
      await worker?.close();
      worker = undefined;
    }
    async function start() {
      if (worker) throw new Error('The fixture worker is already running.');
      worker = await startWorkerServices({
        database,
        config,
        workerId,
        getSettings: () => runtime.settings,
        fetch: fetcher,
        mail,
      });
      return worker;
    }
    async function mission(goal: string, agent: 'cos' | 'comms' = 'cos') {
      return createMission(
        database,
        userId,
        { projectId: project.id, goal, agent, requestId: randomUUID() },
        { maxSteps: 12, maxCostUsd: 1, maxWallTimeSeconds: 60 },
      );
    }
    async function finished(runId: string, status = 'completed') {
      await vi.waitFor(
        async () => {
          const context = await missionContext(database, runId);
          expect(context?.run.status, context?.run.reason ?? undefined).toBe(status);
          expect(context?.run.claimKey).toBeNull();
        },
        { timeout: 12000, interval: 30 },
      );
      return (await missionContext(database, runId))!;
    }
    function message(id: number, text: string): TelegramUpdate {
      return {
        update_id: id,
        message: {
          message_id: id + 1,
          from: { id: fixtureSender, is_bot: false },
          chat: { id: fixtureSender, type: 'private' },
          text,
        },
      };
    }
    async function close() {
      await stop();
      await heartbeat?.stop();
      await app.close();
      await runtime.close();
      const queue = await database.pool.query<{ name: string | null }>(
        "SELECT to_regclass('sazuz_jobs.job')::text AS name",
      );
      if (queue.rows[0]?.name)
        await database.pool.query('DELETE FROM sazuz_jobs.job WHERE name=$1', [MISSION_QUEUE]);
      await database.pool.query(
        'DELETE FROM installation; DELETE FROM setup_sessions; DELETE FROM settings_history; DELETE FROM settings; TRUNCATE TABLE audit_log, audit_chain_state; DELETE FROM vault_meta; DELETE FROM secrets; DELETE FROM cost_ledger; DELETE FROM users; DELETE FROM verifications; DELETE FROM auth_rate_limits; DELETE FROM security_rate_limits; DELETE FROM models; DELETE FROM execution_control; DELETE FROM execution_nonces; DELETE FROM channel_state; DELETE FROM channel_receipts; DELETE FROM delivery_intents',
      );
      await database.close();
      await prerequisite.close();
      if (
        resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
        directory.includes('sazuz-phase3-services-')
      )
        await rm(directory, { recursive: true, force: true });
    }
    return {
      database,
      runtime,
      services,
      config,
      workerId,
      userId,
      project,
      references,
      request,
      setting,
      start,
      stop,
      close,
      mission,
      finished,
      fetcher,
      executionRequests,
      modelRequests,
      updates,
      telegramMessages,
      offsets,
      credentials,
      mailPolls,
      sent,
      message,
      logs: prerequisite.logLines,
      setHealthReady(value: boolean) {
        healthReady = value;
      },
      setPollAvailable(value: boolean) {
        pollAvailable = value;
      },
      async abandon(runId: string) {
        await database.orm
          .update(runs)
          .set({ status: 'cancelled', claimKey: null, workerId: null, claimedAt: null })
          .where(eq(runs.id, runId));
      },
    };
  } catch (error) {
    for (const close of [
      () => worker?.close(),
      () => heartbeat?.stop(),
      () => app.close(),
      () => runtime.close(),
      () => database.close(),
      () => prerequisite.close(),
    ]) {
      try {
        await close();
      } catch {
        prerequisite.logger.error(
          { code: 'WORKER_FIXTURE_CLEANUP_FAILED' },
          'A failed worker fixture resource could not be closed.',
        );
      }
    }
    throw error;
  }
}
export type WorkerFixture = Awaited<ReturnType<typeof openWorkerFixture>>;
