import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { freshSettings, type SettingsDocument } from '@sazuz/config/settings';
import {
  agentMessages,
  approvals,
  auditLog,
  channelReceipts,
  channelState,
  controlRun,
  costLedger,
  createDatabase,
  createMission,
  createProject,
  deliveryIntents,
  digests,
  executionControl,
  jsonValue,
  migrateDatabase,
  missions,
  notifications,
  runs,
  telegramBindings,
  threads,
  toolCalls,
  triggerEvents,
  users,
  valueHash,
  workKey,
  type Database,
} from '@sazuz/db';
import { runControlSchema, type Mission } from '@sazuz/core/missions';
import type { GenerateRequest } from '../../packages/llm/src/contracts.js';
import { secretRedactor } from '@sazuz/vault';
import { createTelegramClient } from '../../packages/channels/src/index.js';
import type { MailTransport } from '../../packages/connectors/src/index.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { decideApproval } from '../../packages/runtime/src/durable-store.js';
import { durableCheckpointSchema } from '../../packages/runtime/src/durable-contracts.js';
import { newCheckpoint } from '../../packages/runtime/src/loop.js';
import {
  createMissionQueue,
  MISSION_QUEUE,
  type MissionQueue,
} from '../../packages/runtime/src/queue.js';
import {
  createAutomationRunner,
  expireApprovals,
  insertTrigger,
} from '../../packages/runtime/src/automation.js';
import {
  collectNotifications,
  createNotificationRouter,
} from '../../packages/runtime/src/notifications.js';
import { createTelegramService } from '../../packages/runtime/src/telegram.js';
import type { ToolRegistry } from '../../packages/tools/src/index.js';
import { openIntegrationDatabase, type IntegrationDatabase } from './database-fixture.js';
import {
  createFixtureRouter,
  createFixtureTools,
  fixtureEmail,
  fixtureMailAccount,
  fixtureMailPassword,
} from './phase-three-runtime-worker.js';

const ownerId = 'phase3_runtime_owner';
const senderId = '12345678';
const botId = '987654321';
const botToken = '987654321:phase3-runtime-bot-fixture-token-39802178';
const limits = { maxSteps: 12, maxCostUsd: 1, maxWallTimeSeconds: 120 };
type Executor = ReturnType<typeof createDurableExecutor>;
type EffectRecord = { count: number; value: string; reads: number };

describe('Phase 3 durable runtime against PostgreSQL and real worker processes', () => {
  let prerequisite: IntegrationDatabase;
  let database: Database;
  let settings: SettingsDocument;
  let directory: string;
  let projectId: string;
  let otherProjectId: string;
  let owned = false;
  const queues = new Set<MissionQueue>();
  const children = new Set<ChildProcess>();
  const serverClosers = new Set<() => Promise<void>>();
  const metrics: Record<string, number> = {};
  const getSettings = () => settings;

  async function assertOwnedDatabase() {
    const result = await database.pool.query<{
      name: string;
      strangers: number;
      installed: number;
      workers: number;
    }>(
      'SELECT current_database() AS name, (SELECT count(*)::int FROM users WHERE id <> $1) AS strangers, (SELECT count(*)::int FROM installation) AS installed, (SELECT count(*)::int FROM worker_heartbeats) AS workers',
      [ownerId],
    );
    const row = result.rows[0];
    if (!row?.name.endsWith('_test') || row.strangers || row.installed || row.workers)
      throw new Error('The runtime fixture refuses to clear unrelated data or active workers.');
  }

  async function clearOwnedData() {
    if (!owned) return;
    await assertOwnedDatabase();
    await database.orm.delete(users).where(eq(users.id, ownerId));
    // These tables have no user foreign key; the initial empty-database guard reserves them for this fixture.
    await database.pool.query('TRUNCATE TABLE audit_log, audit_chain_state');
    await database.orm.delete(channelReceipts);
    await database.orm.delete(channelState);
    await database.orm.delete(deliveryIntents);
    await database.orm.delete(executionControl);
    const queueTable = await database.pool.query<{ name: string | null }>(
      "SELECT to_regclass('sazuz_jobs.job')::text AS name",
    );
    if (queueTable.rows[0]?.name)
      await database.pool.query('DELETE FROM sazuz_jobs.job WHERE name=$1', [MISSION_QUEUE]);
  }

  async function stopChild(child: ChildProcess, force = false) {
    if (child.exitCode !== null || child.signalCode !== null) {
      children.delete(child);
      return;
    }
    const exited = once(child, 'exit');
    if (force || !child.connected) child.kill('SIGKILL');
    else child.send({ kind: 'stop' });
    try {
      await vi.waitFor(
        () => expect(child.exitCode !== null || child.signalCode !== null).toBe(true),
        { timeout: 6000, interval: 30 },
      );
    } catch {
      child.kill('SIGKILL');
    }
    await exited;
    children.delete(child);
  }

  async function closeQueue(queue: MissionQueue) {
    await queue.close();
    queues.delete(queue);
  }

  beforeAll(async () => {
    prerequisite = await openIntegrationDatabase();
    database = await createDatabase(prerequisite.config, prerequisite.logger, {
      maxConnections: 12,
    });
    await migrateDatabase(database);
    const occupied = await database.pool.query<{ count: number }>(
      'SELECT ((SELECT count(*) FROM users)+(SELECT count(*) FROM projects)+(SELECT count(*) FROM installation)+(SELECT count(*) FROM worker_heartbeats)+(SELECT count(*) FROM audit_log)+(SELECT count(*) FROM channel_receipts)+(SELECT count(*) FROM channel_state)+(SELECT count(*) FROM delivery_intents))::int AS count',
    );
    if (occupied.rows[0]?.count !== 0)
      throw new Error(
        'Runtime acceptance requires an empty dedicated test database. Existing data was preserved.',
      );
    directory = await mkdtemp(join(tmpdir(), 'sazuz-phase3-runtime-'));
    owned = true;
  });

  beforeEach(async () => {
    settings = freshSettings();
    settings.general.value.timezone = 'UTC';
    settings.budgets.value = {
      ...settings.budgets.value,
      perRunUsd: 1,
      dailyUsd: 10,
      monthlyUsd: 100,
      maxWallTimeSeconds: 120,
    };
    settings.profile.value = {
      ...settings.profile.value,
      quietStart: '00:00',
      quietEnd: '00:00',
      digestTimes: ['09:00', '18:00'],
      noiseBudget: 5,
    };
    settings.connectors.value.accounts = [fixtureMailAccount];
    await database.orm.insert(users).values({
      id: ownerId,
      name: 'Runtime acceptance owner',
      email: 'phase3-runtime@example.test',
    });
    projectId = (
      await createProject(database, ownerId, {
        name: 'Runtime acceptance',
        brief: 'A deterministic fixture project.',
        privacy: 'private',
        budgetUsd: 100,
      })
    ).id;
    otherProjectId = (
      await createProject(database, ownerId, {
        name: 'Separate private project',
        brief: 'Private project data.',
        privacy: 'private',
        budgetUsd: 100,
      })
    ).id;
  });

  afterEach(async () => {
    for (const child of [...children]) await stopChild(child);
    for (const queue of [...queues]) await closeQueue(queue);
    for (const close of [...serverClosers]) {
      await close();
      serverClosers.delete(close);
    }
    await clearOwnedData();
  });

  afterAll(async () => {
    if (owned) {
      await clearOwnedData();
      const base = resolve(tmpdir()) + sep;
      const target = resolve(directory);
      if (!target.startsWith(base) || !target.includes('sazuz-phase3-runtime-'))
        throw new Error('Unsafe fixture cleanup path.');
      await rm(target, { recursive: true, force: true });
    }
    await database?.close();
    await prerequisite?.close();
    process.stdout.write(`Phase 3 runtime acceptance metrics: ${JSON.stringify(metrics)}\n`);
  });

  async function mission(
    agent: 'cos' | 'researcher' | 'comms' | 'coder' = 'coder',
    caps = limits,
    title = 'Acceptance mission',
  ): Promise<Mission> {
    return createMission(
      database,
      ownerId,
      { projectId, title, goal: title, agent, requestId: randomUUID() },
      caps,
    );
  }
  async function runRow(runId: string) {
    const [row] = await database.orm.select().from(runs).where(eq(runs.id, runId));
    if (!row) throw new Error('The fixture run is missing.');
    return row;
  }
  async function waitRun(runId: string, status: string, timeout = 15_000) {
    await vi.waitFor(
      async () => {
        const row = await runRow(runId);
        expect(row.status).toBe(status);
        expect(row.claimKey).toBeNull();
      },
      { timeout, interval: 30 },
    );
    return runRow(runId);
  }
  function executor(tools: ToolRegistry, router = createFixtureRouter()): Executor {
    return createDurableExecutor({
      database,
      workerId: 'phase3-runtime-parent',
      dataDir: directory,
      getSettings,
      tools,
      router: () => router,
      secret: <T>(_reference: string, _scope: unknown, consume: (value: string) => Promise<T>) =>
        consume(fixtureMailPassword),
    });
  }
  async function startQueue(worker: Executor) {
    const queue = await createMissionQueue(database);
    queues.add(queue);
    await queue.work((id) => worker.execute(id));
    return queue;
  }
  async function queued(worker: Executor, runId: string, status = 'completed') {
    const queue = await startQueue(worker);
    await queue.recover();
    await queue.dispatch();
    const row = await waitRun(runId, status);
    await closeQueue(queue);
    return row;
  }
  async function pendingApproval(runId: string, kind: 'policy' | 'uncertain' = 'policy') {
    const [row] = await database.orm
      .select()
      .from(approvals)
      .where(
        and(eq(approvals.runId, runId), eq(approvals.kind, kind), eq(approvals.status, 'pending')),
      );
    if (!row) throw new Error('Expected a durable pending approval.');
    return row;
  }
  function mailFixture() {
    const sent: { messageId: string; to: string[]; text: string }[] = [];
    const mail: MailTransport = {
      list: () => Promise.resolve({ uidValidity: '17', messages: [], hasMore: false }),
      read: () =>
        Promise.resolve({
          uid: 1,
          subject: 'Fixture',
          from: 'sender@example.test',
          text: 'Fixture message',
          receivedAt: '2026-11-03T09:00:00Z',
        }),
      send: (input) => {
        sent.push({
          messageId: input.messageId,
          to: [...input.message.to],
          text: input.message.text,
        });
        return Promise.resolve({
          messageId: input.messageId,
          accepted: input.message.to,
          rejected: [],
        });
      },
      findSent: () => Promise.resolve(null),
    };
    const tools = createFixtureTools({ mail });
    const worker = executor(
      tools,
      createFixtureRouter({ toolName: 'email.send', args: fixtureEmail }),
    );
    return { sent, tools, worker };
  }
  async function bindTelegram(project = projectId) {
    await database.orm.insert(telegramBindings).values({
      id: workKey('bnd'),
      userId: ownerId,
      projectId: project,
      senderId,
      chatId: senderId,
    });
  }
  function telegram(tools: ToolRegistry) {
    const apiMethods: string[] = [];
    const client = createTelegramClient({
      secretRef: 'secret://sec_00000000000000000000000002',
      secret: <T>(_reference: string, consume: (value: string) => Promise<T>) => consume(botToken),
      fetch: (input) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        expect(url.origin).toBe('https://api.telegram.org');
        const method = url.pathname.split('/').at(-1)!;
        apiMethods.push(method);
        if (method === 'getMe')
          return Promise.resolve(
            Response.json({ ok: true, result: { id: Number(botId), is_bot: true } }),
          );
        if (method === 'answerCallbackQuery')
          return Promise.resolve(Response.json({ ok: true, result: true }));
        if (method === 'getUpdates')
          return Promise.resolve(Response.json({ ok: true, result: [] }));
        return Promise.resolve(
          Response.json({ ok: true, result: { message_id: 11, chat: { id: Number(senderId) } } }),
        );
      },
    });
    const service = createTelegramService({
      database,
      getSettings,
      tools,
      signal: new AbortController().signal,
      client,
      secret: <T>(_reference: string, _scope: unknown, consume: (value: string) => Promise<T>) =>
        consume(botToken),
    });
    return { service, apiMethods };
  }

  async function effectFixture(mode: 'hold' | 'success' | 'uncertain') {
    const effects = new Map<string, EffectRecord>();
    let currentMode = mode;
    const held = new Set<ServerResponse>();
    const server = createServer((request, response) => {
      const handle = async () => {
        const key = decodeURIComponent((request.url ?? '').replace(/^\/effects\//, ''));
        if (request.method === 'GET') {
          const entry = effects.get(key);
          if (entry) entry.reads++;
          if (!entry || currentMode === 'uncertain') {
            response.writeHead(404).end();
            return;
          }
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ written: true, value: entry.value }));
          return;
        }
        if (request.method !== 'POST') {
          response.writeHead(405).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const value: unknown = chunk;
          if (!Buffer.isBuffer(value)) throw new Error('Invalid fixture request chunk.');
          chunks.push(value);
          if (chunks.reduce((total, item) => total + item.byteLength, 0) > 4096)
            throw new Error('Oversized fixture request.');
        }
        const payload = z
          .strictObject({ value: z.string().max(1000) })
          .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        const prior = effects.get(key);
        effects.set(key, {
          count: (prior?.count ?? 0) + 1,
          value: payload.value,
          reads: prior?.reads ?? 0,
        });
        if (currentMode === 'hold') {
          held.add(response);
          response.on('close', () => held.delete(response));
          return;
        }
        if (currentMode === 'uncertain') {
          response.writeHead(503).end();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ written: true, value: payload.value }));
      };
      void handle().catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP port.');
    const close = async () => {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    };
    serverClosers.add(close);
    return {
      effects,
      origin: `http://127.0.0.1:${address.port}`,
      setMode: (value: typeof mode) => {
        currentMode = value;
      },
    };
  }
  async function startChild(origin: string) {
    const child = fork(
      fileURLToPath(new URL('./phase-three-runtime-worker.ts', import.meta.url)),
      [],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        execArgv: ['--import', 'tsx'],
        windowsHide: true,
        env: {
          ...process.env,
          SAZUZ_PHASE3_RUNTIME_WORKER: '1',
          SAZUZ_PHASE3_FIXTURE_ORIGIN: origin,
          SAZUZ_PHASE3_DATA_DIR: directory,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    children.add(child);
    let ready = false;
    let failed = false;
    let stage = 'module import';
    let stderr = '';
    child.stderr?.on('data', (data: Buffer) => {
      stderr = secretRedactor.redactText(stderr + data.toString('utf8')).slice(-4000);
    });
    child.on('message', (value: unknown) => {
      const message = z
        .object({
          kind: z.enum(['ready', 'failed', 'stopped', 'stage']),
          name: z.string().optional(),
        })
        .safeParse(value);
      if (message.success) {
        ready ||= message.data.kind === 'ready';
        failed ||= message.data.kind === 'failed';
        if (message.data.kind === 'stage') stage = message.data.name ?? stage;
      }
    });
    await vi.waitFor(
      () => {
        if (failed || child.exitCode !== null)
          throw new Error(`Worker fixture did not start. ${stderr}`);
        expect(ready, `Worker startup stage: ${stage}. ${stderr}`).toBe(true);
      },
      { timeout: 30_000, interval: 40 },
    );
    return child;
  }

  it('kills a separate pg-boss worker after its external fixture effect and reconciles without replay', async () => {
    const fixture = await effectFixture('hold');
    const work = await mission();
    const first = await startChild(fixture.origin);
    await vi.waitFor(
      () => expect([...fixture.effects.values()].map((row) => row.count)).toEqual([1]),
      { timeout: 15_000, interval: 40 },
    );
    const [intent] = await database.orm
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.runId, work.run.id));
    expect(intent).toMatchObject({ status: 'intent', toolName: 'files.fixture_write', attempt: 1 });
    expect((await runRow(work.run.id)).claimKey).not.toBeNull();
    await stopChild(first, true);
    fixture.setMode('success');
    const replacement = await startChild(fixture.origin);
    await waitRun(work.run.id, 'completed', 15_000);
    await stopChild(replacement);
    const [done] = await database.orm
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.runId, work.run.id));
    expect(done).toMatchObject({ status: 'done', attempt: 1 });
    expect([...fixture.effects.values()]).toEqual([
      { count: 1, value: 'durable fixture effect', reads: 1 },
    ]);
    metrics.killedWorkers = 1;
    metrics.recoveredEffectExecutions = [...fixture.effects.values()][0]!.count;
  }, 75_000);

  it('persists an uncertain action and requires an explicit resolution before the queued run continues', async () => {
    const fixture = await effectFixture('uncertain');
    const tools = createFixtureTools({ fixtureOrigin: fixture.origin });
    const worker = executor(
      tools,
      createFixtureRouter({
        toolName: 'files.fixture_write',
        args: { value: 'Uncertain fixture write' },
      }),
    );
    const work = await mission();
    await queued(worker, work.run.id, 'waiting_approval');
    const approval = await pendingApproval(work.run.id, 'uncertain');
    expect([...fixture.effects.values()][0]?.count).toBe(1);
    await worker.execute(work.run.id);
    expect([...fixture.effects.values()][0]?.count).toBe(1);
    await expect(
      controlRun(
        database,
        ownerId,
        work.run.id,
        runControlSchema.parse({ action: 'resume', version: (await runRow(work.run.id)).version }),
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    await decideApproval(
      database,
      ownerId,
      approval.id,
      {
        action: 'confirm_done',
        version: approval.version,
        note: 'Confirmed in the local fixture.',
      },
      tools,
      getSettings,
    );
    await queued(worker, work.run.id);
    expect([...fixture.effects.values()][0]?.count).toBe(1);
    const [done] = await database.orm
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.runId, work.run.id));
    expect(done?.result).toMatchObject({ output: { confirmedByUser: true } });
  });

  it('requires Balanced email approval and resumes through Telegram and pg-boss in under five seconds', async () => {
    const fixture = mailFixture();
    const work = await mission('comms');
    await queued(fixture.worker, work.run.id, 'waiting_approval');
    expect(fixture.sent).toHaveLength(0);
    const approval = await pendingApproval(work.run.id);
    await bindTelegram();
    const { service, apiMethods } = telegram(fixture.tools);
    const queue = await startQueue(fixture.worker);
    const callback = {
      update_id: 1001,
      callback_query: {
        id: 'approval-callback-one',
        from: { id: Number(senderId) },
        message: { message_id: 1, chat: { id: Number(senderId), type: 'private' } },
        data: `a:${approval.id}:${approval.version.toString(36)}:y`,
      },
    };
    const started = performance.now();
    expect((await service.handle(callback)).status).toBe('approval');
    await queue.dispatch();
    await waitRun(work.run.id, 'completed', 4500);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(5000);
    metrics.telegramApprovalResumeMs = Math.round(elapsed);
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]).toMatchObject({ to: fixtureEmail.to, text: fixtureEmail.text });
    expect((await service.handle(callback)).status).toBe('duplicate');
    expect(fixture.sent).toHaveLength(1);
    expect(apiMethods).toContain('getMe');
    expect(apiMethods).toContain('answerCallbackQuery');
  });

  it('ignores and audits an unpaired Telegram sender without storing their message', async () => {
    const { service } = telegram(createFixtureTools());
    const text = 'unpaired private message that must stay out of audit';
    expect(
      (
        await service.handle({
          update_id: 1002,
          message: {
            message_id: 2,
            from: { id: 99999999 },
            chat: { id: 99999999, type: 'private' },
            text,
          },
        })
      ).status,
    ).toBe('ignored');
    expect(await database.orm.select().from(missions)).toHaveLength(0);
    const audit = await database.orm.select().from(auditLog);
    expect(audit.some((row) => row.action === 'telegram.unpaired_sender')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(text);
  });

  it('rejects stale approval versions and executes only the edited, approved arguments', async () => {
    const fixture = mailFixture();
    const work = await mission('comms');
    await fixture.worker.execute(work.run.id);
    const approval = await pendingApproval(work.run.id);
    await expect(
      decideApproval(
        database,
        ownerId,
        approval.id,
        { action: 'approve', version: approval.version + 1 },
        fixture.tools,
        getSettings,
      ),
    ).rejects.toMatchObject({ code: 'MISSION_CONFLICT' });
    const edited = { ...fixtureEmail, text: 'The owner reviewed this exact replacement.' };
    await decideApproval(
      database,
      ownerId,
      approval.id,
      { action: 'edit_approve', version: approval.version, args: edited },
      fixture.tools,
      getSettings,
    );
    await expect(
      decideApproval(
        database,
        ownerId,
        approval.id,
        { action: 'approve', version: approval.version },
        fixture.tools,
        getSettings,
      ),
    ).rejects.toMatchObject({ code: 'MISSION_CONFLICT' });
    await queued(fixture.worker, work.run.id);
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]?.text).toBe(edited.text);
    const [call] = await database.orm
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.runId, work.run.id));
    expect(call?.argsHash).toBe(valueHash(edited));
  });

  it('does not resurrect cancelled runs or send after an approval expires', async () => {
    const fixture = mailFixture();
    const cancelled = await mission('comms');
    await fixture.worker.execute(cancelled.run.id);
    const cancelledApproval = await pendingApproval(cancelled.run.id);
    await controlRun(
      database,
      ownerId,
      cancelled.run.id,
      runControlSchema.parse({
        action: 'cancel',
        version: (await runRow(cancelled.run.id)).version,
      }),
    );
    await expect(
      decideApproval(
        database,
        ownerId,
        cancelledApproval.id,
        { action: 'approve', version: cancelledApproval.version },
        fixture.tools,
        getSettings,
      ),
    ).rejects.toMatchObject({ code: 'MISSION_CONFLICT' });
    await database.orm
      .update(approvals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(approvals.id, cancelledApproval.id));
    await expireApprovals(database);
    expect((await runRow(cancelled.run.id)).status).toBe('cancelled');
    const expired = await mission('comms');
    await fixture.worker.execute(expired.run.id);
    const approval = await pendingApproval(expired.run.id);
    await database.orm
      .update(approvals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(approvals.id, approval.id));
    await expect(
      decideApproval(
        database,
        ownerId,
        approval.id,
        { action: 'approve', version: approval.version },
        fixture.tools,
        getSettings,
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    await expireApprovals(database);
    await queued(fixture.worker, expired.run.id);
    expect(fixture.sent).toHaveLength(0);
    expect((await runRow(cancelled.run.id)).status).toBe('cancelled');
  });

  it('re-evaluates a new hard deny after an approval was accepted', async () => {
    const fixture = mailFixture();
    const work = await mission('comms');
    await fixture.worker.execute(work.run.id);
    const approval = await pendingApproval(work.run.id);
    await decideApproval(
      database,
      ownerId,
      approval.id,
      { action: 'approve', version: approval.version },
      fixture.tools,
      getSettings,
    );
    settings.security.value.rules = [
      {
        id: 'stop-fixture-mail',
        scope: { type: 'global' },
        match: { tool: 'email.send' },
        when: [],
        action: 'deny',
      },
    ];
    await queued(fixture.worker, work.run.id);
    expect(fixture.sent).toHaveLength(0);
    expect(
      await database.orm.select().from(toolCalls).where(eq(toolCalls.runId, work.run.id)),
    ).toHaveLength(0);
  });

  it('extends a step-limited checkpoint without repeating a completed tool', async () => {
    let reads = 0;
    const tools = createFixtureTools({
      onRead: () => {
        reads++;
      },
    });
    const worker = executor(tools, createFixtureRouter({ toolName: 'time.fixture_now' }));
    const work = await mission('coder', { ...limits, maxSteps: 1 });
    const stopped = await queued(worker, work.run.id, 'budget_exceeded');
    expect(reads).toBe(1);
    await controlRun(
      database,
      ownerId,
      work.run.id,
      runControlSchema.parse({ action: 'extend', version: stopped.version, addSteps: 1 }),
    );
    const completed = await queued(worker, work.run.id);
    expect(reads).toBe(1);
    expect(completed.step).toBe(2);
  });

  it('aborts a stalled planner at its wall-time cap and resumes after a versioned wall-budget extension', async () => {
    const tools = createFixtureTools();
    const healthyRouter = createFixtureRouter();
    const generate = vi.fn(healthyRouter.generate);
    let planningAttempts = 0;
    let observedDeadlineAbort = false;
    let plannerAbortMs = 0;
    const worker = executor(tools, {
      generate,
      async generateObject<T>(request: GenerateRequest, schema: z.ZodType<T>) {
        planningAttempts++;
        if (planningAttempts === 1) {
          const signal = request.signal;
          if (!signal) throw new Error('The planner must receive the run deadline signal.');
          const started = performance.now();
          if (!signal.aborted) await once(signal, 'abort', { signal: AbortSignal.timeout(5000) });
          observedDeadlineAbort = signal.aborted;
          plannerAbortMs = Math.round(performance.now() - started);
          throw new Error('The fixture planner stopped after the run deadline aborted it.');
        }
        return healthyRouter.generateObject(request, schema);
      },
    });
    const work = await mission('cos', { ...limits, maxWallTimeSeconds: 1 });
    const stopped = await queued(worker, work.run.id, 'budget_exceeded');
    expect(observedDeadlineAbort).toBe(true);
    expect(planningAttempts).toBe(1);
    expect(generate).not.toHaveBeenCalled();
    expect(stopped.reason).toContain('wall-time limit');
    expect(stopped.limits).toMatchObject({ maxWallTimeSeconds: 1 });
    const checkpoint = durableCheckpointSchema.parse(stopped.checkpoint);
    expect(checkpoint).toMatchObject({
      phase: 'planning',
      plan: null,
      loop: { status: 'budget_exceeded', step: 0, pendingCalls: [] },
    });
    expect(
      await database.orm.select().from(toolCalls).where(eq(toolCalls.runId, work.run.id)),
    ).toHaveLength(0);

    const extension = runControlSchema.parse({
      action: 'extend',
      version: stopped.version,
      addWallTimeSeconds: 30,
    });
    const extended = await controlRun(database, ownerId, work.run.id, extension);
    expect(extended.version).toBe(stopped.version + 1);
    expect(extended.limits).toEqual({ ...limits, maxWallTimeSeconds: 31 });
    await expect(controlRun(database, ownerId, work.run.id, extension)).rejects.toMatchObject({
      code: 'MISSION_CONFLICT',
    });

    const completed = await queued(worker, work.run.id);
    expect(planningAttempts).toBe(2);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(completed.limits).toEqual({ ...limits, maxWallTimeSeconds: 31 });
    expect(durableCheckpointSchema.parse(completed.checkpoint).loop.startedAt).toBe(
      checkpoint.loop.startedAt,
    );
    metrics.plannerWallTimeoutMs = plannerAbortMs;
    metrics.wallBudgetExtensionSeconds = 30;
  });

  it('charges actual model usage and preserves global cost caps after a per-run extension', async () => {
    const tools = createFixtureTools();
    const worker = executor(
      tools,
      createFixtureRouter({ toolName: 'time.fixture_now', costUsd: 0.01 }),
    );
    const work = await mission('coder', { ...limits, maxCostUsd: 0.01 });
    const stopped = await queued(worker, work.run.id, 'budget_exceeded');
    expect(stopped.costUsd).toBeCloseTo(0.01);
    await controlRun(
      database,
      ownerId,
      work.run.id,
      runControlSchema.parse({ action: 'extend', version: stopped.version, addCostUsd: 0.01 }),
    );
    const completed = await queued(worker, work.run.id);
    expect(completed.costUsd).toBeCloseTo(0.02);
    settings.budgets.value.dailyUsd = 0.02;
    const capped = await mission('coder');
    const globalStop = await queued(worker, capped.run.id, 'budget_exceeded');
    const before = await database.orm.select().from(costLedger);
    await controlRun(
      database,
      ownerId,
      capped.run.id,
      runControlSchema.parse({ action: 'extend', version: globalStop.version, addCostUsd: 5 }),
    );
    await queued(worker, capped.run.id, 'budget_exceeded');
    expect(await database.orm.select().from(costLedger)).toHaveLength(before.length);
    expect(settings.budgets.value.dailyUsd).toBe(0.02);
  });

  it('finishes a recovered specialist checkpoint without generating its completed work again', async () => {
    const work = await mission('cos');
    const loop = newCheckpoint([
      { role: 'user', content: 'Research the fixture.' },
      { role: 'assistant', content: 'Completed specialist research.' },
    ]);
    loop.step = 1;
    loop.status = 'completed';
    const state = durableCheckpointSchema.parse({
      version: 1,
      phase: 'task',
      agentId: 'researcher',
      taskIndex: 0,
      results: [],
      plan: {
        tasks: [
          { agent: 'researcher', goal: 'Research the fixture.', acceptance: ['Return findings.'] },
        ],
        deliverable: 'Summarize the research.',
      },
      loop,
    });
    await database.orm
      .update(runs)
      .set({
        status: 'running',
        checkpoint: jsonValue(state),
        agentId: 'researcher',
        step: 1,
        claimKey: 'interrupted-specialist',
        workerId: 'dead-worker',
      })
      .where(eq(runs.id, work.run.id));
    const generated: string[] = [];
    const worker = executor(
      createFixtureTools(),
      createFixtureRouter({
        onGenerate: (request) => {
          generated.push(request.messages[0]?.content ?? '');
        },
      }),
    );
    await queued(worker, work.run.id);
    expect(generated).toHaveLength(1);
    expect(generated[0]).toContain('Chief of Staff');
    const messages = await database.orm
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.missionId, work.id));
    expect(messages.filter((item) => item.type === 'result')).toHaveLength(1);
    expect(messages.find((item) => item.type === 'result')?.content).toBe(
      'Completed specialist research.',
    );
  });

  it('schedules Morning Brief once and delivers its completed mission through a digest', async () => {
    settings.channels.value.digest = 'telegram';
    await bindTelegram();
    const before = new Date('2030-01-07T08:59:00Z');
    const at = new Date('2030-01-07T09:00:00Z');
    const trigger = await insertTrigger(
      database,
      ownerId,
      {
        projectId,
        name: 'Morning Brief',
        goal: 'Summarize the morning priorities.',
        agent: 'cos',
        enabled: true,
        config: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' },
      },
      before,
    );
    const automation = createAutomationRunner({
      database,
      getSettings,
      signal: new AbortController().signal,
      listImap: () => Promise.reject(new Error('IMAP is not part of this cron fixture.')),
    });
    await automation.tick(at);
    await automation.tick(at);
    const events = await database.orm
      .select()
      .from(triggerEvents)
      .where(eq(triggerEvents.triggerId, trigger.id));
    expect(events).toHaveLength(1);
    const [scheduled] = await database.orm
      .select()
      .from(missions)
      .where(eq(missions.id, events[0]!.missionId!));
    const [run] = await database.orm.select().from(runs).where(eq(runs.missionId, scheduled!.id));
    await queued(
      executor(
        createFixtureTools(),
        createFixtureRouter({
          text: 'Morning priorities: review the plan and check the calendar.',
        }),
      ),
      run!.id,
    );
    const delivered: string[] = [];
    const router = createNotificationRouter({
      database,
      getSettings,
      deliver: (_recipient, text) => {
        delivered.push(text);
        return Promise.resolve({ messageId: 1 });
      },
    });
    await router.tick(at);
    await router.tick(at);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('Morning priorities');
    expect(await database.orm.select().from(digests)).toHaveLength(1);
    metrics.morningBriefMissionCount = events.length;
    metrics.morningBriefDigestCount = delivered.length;
  });

  it('applies quiet hours, limits a burst to three interruptions, and keeps digests within projects', async () => {
    settings.profile.value = {
      ...settings.profile.value,
      quietStart: '22:00',
      quietEnd: '08:00',
      digestTimes: ['18:00'],
      noiseBudget: 3,
    };
    settings.channels.value = {
      ...settings.channels.value,
      urgent: 'telegram',
      digest: 'telegram',
    };
    await bindTelegram();
    const delivered: { projectId: string; text: string }[] = [];
    const router = createNotificationRouter({
      database,
      getSettings,
      deliver: (recipient, text) => {
        delivered.push({ projectId: recipient.projectId, text });
        return Promise.resolve({ messageId: delivered.length });
      },
    });
    await database.orm.insert(notifications).values(
      Array.from({ length: 10 }, (_, index) => ({
        id: workKey('ntf'),
        userId: ownerId,
        projectId,
        eventKey: `burst:${index}`,
        level: 'urgent',
        title: `Urgent item ${index}`,
        body: 'Review this fixture item.',
        createdAt: new Date('2030-01-07T23:00:00Z'),
      })),
    );
    await router.tick(new Date('2030-01-07T23:00:00Z'));
    expect(delivered).toHaveLength(0);
    await router.tick(new Date('2030-01-08T08:00:00Z'));
    expect(delivered).toHaveLength(3);
    const deferred = await database.orm
      .select()
      .from(notifications)
      .where(eq(notifications.status, 'deferred'));
    expect(deferred).toHaveLength(7);
    expect(deferred.every((row) => row.dueAt?.toISOString() === '2030-01-08T18:00:00.000Z')).toBe(
      true,
    );
    await database.orm.insert(notifications).values({
      id: workKey('ntf'),
      userId: ownerId,
      projectId: otherProjectId,
      eventKey: 'private-other-project',
      level: 'normal',
      title: 'Private other project',
      body: 'Must remain in the second project.',
      status: 'deferred',
      dueAt: new Date('2030-01-08T18:00:00Z'),
    });
    await router.tick(new Date('2030-01-08T18:00:00Z'));
    expect(delivered).toHaveLength(3);
    expect(
      delivered.every(
        (item) =>
          item.projectId === projectId && !item.text.includes('Must remain in the second project.'),
      ),
    ).toBe(true);
    const groups = await database.orm.select().from(digests);
    expect(groups).toHaveLength(2);
    expect(groups.find((item) => item.projectId === otherProjectId)?.deliveryStatus).toBe('web');
    metrics.urgentBurstInterruptions = 3;
  });

  it('does not hide a new urgent item behind two hundred future digest deadlines', async () => {
    settings.channels.value.urgent = 'telegram';
    await bindTelegram();
    const now = new Date('2030-01-07T09:00:00Z');
    await database.orm.insert(notifications).values(
      Array.from({ length: 201 }, (_, index) => ({
        id: workKey('ntf'),
        userId: ownerId,
        projectId,
        eventKey: `future:${index}`,
        level: 'normal',
        title: 'Later digest item',
        body: 'Deferred fixture.',
        status: 'deferred',
        dueAt: new Date('2030-01-07T18:00:00Z'),
        createdAt: new Date('2030-01-07T08:00:00Z'),
      })),
    );
    const urgentId = workKey('ntf');
    await database.orm.insert(notifications).values({
      id: urgentId,
      userId: ownerId,
      projectId,
      eventKey: 'new-urgent',
      level: 'urgent',
      title: 'New approval needs attention',
      body: 'Current item.',
      createdAt: now,
    });
    const delivered: string[] = [];
    await createNotificationRouter({
      database,
      getSettings,
      deliver: (_recipient, text) => {
        delivered.push(text);
        return Promise.resolve({ messageId: 1 });
      },
    }).tick(now);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('New approval');
    expect(
      (await database.orm.select().from(notifications).where(eq(notifications.id, urgentId)))[0]
        ?.status,
    ).toBe('delivered');
  });

  it('collects every approval and completion across the hundred-row notification batches', async () => {
    const cases = Array.from({ length: 202 }, (_, index) => ({
      index,
      threadId: workKey('thr'),
      missionId: workKey('mis'),
      runId: workKey('run'),
    }));
    await database.orm.transaction(async (tx) => {
      await tx
        .insert(threads)
        .values(
          cases.map((item) => ({ id: item.threadId, projectId, title: `Batch ${item.index}` })),
        );
      await tx.insert(missions).values(
        cases.map((item) => ({
          id: item.missionId,
          projectId,
          threadId: item.threadId,
          title: `Batch ${item.index}`,
          goal: 'Batch notification fixture.',
          agent: 'comms',
          requestId: randomUUID(),
          source: 'test',
        })),
      );
      await tx.insert(runs).values(
        cases.map((item) => ({
          id: item.runId,
          missionId: item.missionId,
          agentId: 'comms',
          status: item.index < 101 ? 'waiting_approval' : 'completed',
          limits,
        })),
      );
      await tx.insert(approvals).values(
        cases.slice(0, 101).map((item) => ({
          id: workKey('apr'),
          runId: item.runId,
          callKey: `${item.runId}:1:0`,
          agentId: 'comms',
          toolName: 'email.send',
          args: fixtureEmail,
          argsHash: valueHash(fixtureEmail),
          effect: 'send',
          reason: 'Review the fixture send.',
          risk: 'high',
          ruleId: 'balanced',
          tainted: false,
          kind: 'policy',
          expiresAt: new Date(Date.now() + 60_000),
        })),
      );
    });
    await collectNotifications(database);
    await collectNotifications(database);
    const all = await database.orm.select().from(notifications);
    expect(all.filter((row) => row.eventKey.startsWith('approval:'))).toHaveLength(101);
    expect(all.filter((row) => row.eventKey.startsWith('run:'))).toHaveLength(101);
    metrics.batchNotificationsCollected = all.length;
  });
});
