import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { chatEventSchema, type ChatEvent } from '@sazuz/core/work';
import {
  addMessage,
  approvals,
  createDatabase,
  createProject,
  createThread,
  messages,
  migrateDatabase,
  missionContext,
  missions,
  queueOutbox,
  runs,
  threads,
  users,
  workKey,
  type Database,
} from '@sazuz/db';
import type { ModelRouter } from '../../packages/llm/src/router.js';
import type { GenerateRequest } from '../../packages/llm/src/contracts.js';
import { ToolRegistry, defineTool } from '../../packages/tools/src/index.js';
import { createApp } from '../../apps/server/src/app.js';
import { createPhaseOne, type PhaseOne } from '../../apps/server/src/phase-one.js';
import { registerPhaseOne } from '../../apps/server/src/phase-one-routes.js';
import { createModelServices, registerPhaseTwo } from '../../apps/server/src/phase-two.js';
import { createDurableChat } from '../../apps/server/src/phase-three-chat.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { decideApproval } from '../../packages/runtime/src/durable-store.js';
import {
  createMissionQueue,
  MISSION_QUEUE,
  type MissionQueue,
} from '../../packages/runtime/src/queue.js';
import { openIntegrationDatabase, type IntegrationDatabase } from './database-fixture.js';
import { createFixtureRouter } from './phase-three-runtime-worker.js';

describe('Production chat bridge with PostgreSQL, pg-boss and real HTTP streams', () => {
  let fixture: IntegrationDatabase;
  let database: Database;
  let runtime: PhaseOne;
  let app: Awaited<ReturnType<typeof createApp>>;
  let queue: MissionQueue;
  let directory: string;
  let serverUrl: string;
  let userId: string;
  let owned = false;
  let router: Pick<ModelRouter, 'generate' | 'generateObject'>;
  let reads = 0;
  let alarms = 0;
  let serverModelRequests = 0;
  const cookies = new Map<string, string>();
  const controllers = new Set<AbortController>();
  const releases = new Set<() => void>();
  const origin = 'http://localhost:7777';
  const passphrase = 'durable-chat-vault-passphrase-293801';
  const registry = new ToolRegistry([
    defineTool({
      name: 'time.fixture_now',
      description: 'Read the deterministic fixture clock.',
      input: z.strictObject({}),
      output: z.strictObject({ at: z.iso.datetime() }),
      effect: 'read',
      scope: 'internal',
      untrusted: false,
      run: () => {
        reads++;
        return Promise.resolve({ at: '2026-11-03T09:00:00.000Z' });
      },
    }),
    defineTool({
      name: 'time.fixture_alarm',
      description: 'Set an alarm inside the deterministic fixture.',
      input: z.strictObject({ label: z.string().min(1).max(100) }),
      output: z.strictObject({ scheduled: z.literal(true) }),
      effect: 'write',
      scope: 'external',
      untrusted: false,
      run: () => {
        alarms++;
        return Promise.resolve({ scheduled: true as const });
      },
      verify: () =>
        Promise.resolve(
          alarms
            ? { status: 'done' as const, result: { scheduled: true as const } }
            : { status: 'not_done' as const },
        ),
    }),
  ]);
  function headers() {
    return {
      origin,
      'content-type': 'application/json',
      cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
    };
  }
  async function request(method: 'GET' | 'POST', url: string, payload?: unknown) {
    const response = await app.inject({
      method,
      url,
      headers: headers(),
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    for (const cookie of response.cookies) cookies.set(cookie.name, cookie.value);
    return response;
  }
  function controller() {
    const value = new AbortController();
    controllers.add(value);
    return value;
  }
  function postChat(
    threadId: string,
    input: { content: string; requestId: string },
    abort = controller(),
  ) {
    return fetch(new URL(`/api/threads/${threadId}/chat`, serverUrl), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(input),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]),
      redirect: 'error',
    });
  }
  async function readEvents(response: Response): Promise<ChatEvent[]> {
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events: ChatEvent[] = [];
    let pending = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const end = pending.indexOf('\n\n');
          if (end < 0) break;
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (frame.startsWith('data: '))
            events.push(chatEventSchema.parse(JSON.parse(frame.slice(6))));
        }
      }
      expect(pending + decoder.decode()).toBe('');
      return events;
    } finally {
      reader.releaseLock();
    }
  }
  async function conversation() {
    const project = await createProject(database, userId, {
      name: 'Durable chat fixture',
      brief: 'Use the previous conversation when answering.',
      privacy: 'private',
    });
    const thread = await createThread(database, userId, {
      projectId: project.id,
      title: 'A persistent conversation',
    });
    return { project, thread: thread! };
  }
  async function accepted(threadId: string, requestId: string) {
    let row: typeof missions.$inferSelect | undefined;
    await vi.waitFor(
      async () => {
        [row] = await database.orm
          .select()
          .from(missions)
          .where(and(eq(missions.threadId, threadId), eq(missions.requestId, requestId)));
        expect(row).toBeDefined();
      },
      { timeout: 5000, interval: 20 },
    );
    const [run] = await database.orm.select().from(runs).where(eq(runs.missionId, row!.id));
    return { mission: row!, run: run! };
  }
  async function finished(runId: string, status = 'completed') {
    await vi.waitFor(
      async () => {
        const context = await missionContext(database, runId);
        expect(context?.run.status).toBe(status);
        expect(context?.run.claimKey).toBeNull();
      },
      { timeout: 10_000, interval: 20 },
    );
  }

  beforeAll(async () => {
    fixture = await openIntegrationDatabase();
    database = await createDatabase(fixture.config, fixture.logger, { maxConnections: 12 });
    await migrateDatabase(database);
    const occupied = await database.pool.query<{ count: number }>(
      'SELECT ((SELECT count(*) FROM installation)+(SELECT count(*) FROM users)+(SELECT count(*) FROM worker_heartbeats))::int AS count',
    );
    if (occupied.rows[0]?.count !== 0)
      throw new Error('Use an empty dedicated database for the durable chat fixture.');
    directory = await mkdtemp(join(tmpdir(), 'sazuz-phase3-chat-'));
    runtime = await createPhaseOne(database, { ...fixture.config, dataDir: directory });
    owned = true;
    app = await createApp({
      logger: fixture.logger,
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
    registerPhaseOne(app, runtime);
    registerPhaseTwo(
      app,
      runtime,
      createModelServices(runtime, {
        fetch: () => {
          serverModelRequests++;
          throw new Error('Production chat must execute through the worker.');
        },
      }),
      { chat: createDurableChat(app, runtime, { pollIntervalMs: 20 }) },
    );
    const token = (await readFile(join(directory, 'secrets/setup-token'), 'utf8')).trim();
    expect((await request('POST', '/api/setup/gate', { token })).statusCode).toBe(200);
    expect(
      (
        await request('POST', '/api/setup/admin', {
          name: 'Chat owner',
          email: 'durable-chat@example.test',
          password: 'durable-chat-admin-password-392108',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request('POST', '/api/auth/sign-in/email', {
          email: 'durable-chat@example.test',
          password: 'durable-chat-admin-password-392108',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await request('POST', '/api/vault/initialize', { passphrase, mode: 'strict' })).statusCode,
    ).toBe(200);
    userId = (await runtime.state()).adminId!;
    serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    queue = await createMissionQueue(database);
    await queue.work((runId) =>
      createDurableExecutor({
        database,
        workerId: 'durable-chat-fixture-worker',
        dataDir: directory,
        getSettings: () => runtime.settings,
        tools: registry,
        router: () => router,
        onToken: async (id, text, step) => {
          await database.pool.query('SELECT pg_notify($1,$2)', [
            'run_token',
            JSON.stringify({ runId: id, step, text }),
          ]);
        },
      }).execute(runId),
    );
  });
  beforeEach(() => {
    reads = 0;
    alarms = 0;
    router = createFixtureRouter();
  });
  afterEach(() => {
    for (const release of releases) release();
    releases.clear();
    for (const abort of controllers) abort.abort();
    controllers.clear();
    expect(serverModelRequests).toBe(0);
  });
  afterAll(async () => {
    await app?.close();
    await queue?.close();
    await runtime?.close();
    if (owned) {
      await database.pool.query('DELETE FROM sazuz_jobs.job WHERE name=$1', [MISSION_QUEUE]);
      await database.pool.query(
        'DELETE FROM installation; DELETE FROM setup_sessions; DELETE FROM settings_history; DELETE FROM settings; TRUNCATE TABLE audit_log, audit_chain_state; DELETE FROM vault_meta; DELETE FROM secrets; DELETE FROM users; DELETE FROM verifications; DELETE FROM auth_rate_limits; DELETE FROM security_rate_limits; DELETE FROM models; DELETE FROM execution_control',
      );
    }
    await database?.close();
    await fixture?.close();
    if (
      directory &&
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
      directory.includes('sazuz-phase3-chat-')
    )
      await rm(directory, { recursive: true, force: true });
  });

  it('checks authentication, ownership, vault readiness and body validation before accepting work', async () => {
    const { thread } = await conversation();
    const input = { content: 'A private request.', requestId: randomUUID() };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/threads/${thread.id}/chat`,
          headers: { origin, 'content-type': 'application/json' },
          payload: JSON.stringify(input),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await request('POST', `/api/threads/${thread.id}/chat`, { ...input, unknown: true }))
        .statusCode,
    ).toBe(400);
    const otherUser = workKey('usr');
    await database.orm
      .insert(users)
      .values({ id: otherUser, name: 'Other owner', email: 'other-chat-owner@example.test' });
    const other = await createProject(database, otherUser, { name: 'Other private project' });
    const otherThread = await createThread(database, otherUser, {
      projectId: other.id,
      title: 'Other conversation',
    });
    expect((await request('POST', `/api/threads/${otherThread!.id}/chat`, input)).statusCode).toBe(
      404,
    );
    await runtime.vault.lock();
    expect((await request('POST', `/api/threads/${thread.id}/chat`, input)).statusCode).toBe(423);
    await runtime.vault.unlock(passphrase);
    expect(await database.orm.select().from(missions)).toHaveLength(0);
  });

  it('streams worker tokens and persisted tool results, preserves history, and replays one request once', async () => {
    const { project, thread } = await conversation();
    await addMessage(database, {
      id: workKey('msg'),
      threadId: thread.id,
      role: 'user',
      content: 'Remember the copper notebook.',
      requestId: randomUUID(),
    });
    await addMessage(database, {
      id: workKey('msg'),
      threadId: thread.id,
      role: 'assistant',
      content: 'I will remember the copper notebook.',
      requestId: randomUUID(),
    });
    const generated: GenerateRequest[] = [];
    const base = createFixtureRouter({
      toolName: 'time.fixture_now',
      text: 'The copper notebook is still in context.',
      onGenerate: (input) => generated.push(input),
    });
    router = {
      generateObject: base.generateObject,
      generate: async (input) => {
        const result = await base.generate(input);
        const split = Math.ceil(result.text.length / 2);
        await input.onToken?.(result.text.slice(0, split));
        await delay(60);
        await input.onToken?.(result.text.slice(split));
        await delay(60);
        return result;
      },
    };
    const input = { content: 'Read the clock and recall my notebook.', requestId: randomUUID() };
    const response = await postChat(thread.id, input);
    const streamed = readEvents(response);
    const acceptedRun = await accepted(thread.id, input.requestId);
    expect(acceptedRun.mission.source).toBe('chat');
    expect(acceptedRun.mission.agent).toBe('cos');
    await queue.dispatch();
    const events = await streamed;
    await finished(acceptedRun.run.id);
    expect(events.some((event) => event.type === 'text.delta')).toBe(true);
    expect(events).toContainEqual({
      type: 'tool.result',
      id: 'fixture-call-1',
      name: 'time.fixture_now',
      output: { at: '2026-11-03T09:00:00.000Z' },
      status: 'done',
    });
    const completedEvent = events.at(-1);
    expect(completedEvent).toMatchObject({
      type: 'run.status',
      status: 'completed',
    });
    expect(completedEvent?.type === 'run.status' && completedEvent.message).toContain(
      `View mission: /missions/${acceptedRun.mission.id}`,
    );
    const finalMessage = events.findLast((event) => event.type === 'message.completed');
    expect(finalMessage?.type === 'message.completed' && finalMessage.message.content).toBe(
      'The copper notebook is still in context.',
    );
    expect(generated.every((entry) => entry.privateOnly)).toBe(true);
    expect(generated[0]?.messages).toEqual(
      expect.arrayContaining([
        { role: 'user', content: 'Remember the copper notebook.' },
        { role: 'assistant', content: 'I will remember the copper notebook.' },
        { role: 'user', content: input.content },
      ]),
    );
    expect(
      await database.orm.select().from(threads).where(eq(threads.projectId, project.id)),
    ).toHaveLength(1);
    const replay = await readEvents(await postChat(thread.id, input));
    expect(replay.filter((event) => event.type === 'message.completed')).toEqual(
      events.filter((event) => event.type === 'message.completed'),
    );
    expect(reads).toBe(1);
    expect(
      await database.orm.select().from(missions).where(eq(missions.threadId, thread.id)),
    ).toHaveLength(1);
    expect(
      await database.orm
        .select()
        .from(messages)
        .where(and(eq(messages.threadId, thread.id), eq(messages.requestId, input.requestId))),
    ).toHaveLength(1);
    expect(
      await database.orm
        .select()
        .from(queueOutbox)
        .where(eq(queueOutbox.runId, acceptedRun.run.id)),
    ).toHaveLength(0);
  });

  it('retains a disconnected queued request, accepts 24000 characters, and rejects an overlapping turn', async () => {
    const { thread } = await conversation();
    const input = { content: 'x'.repeat(24000), requestId: randomUUID() };
    const abort = controller();
    const response = await postChat(thread.id, input, abort);
    const streamed = readEvents(response);
    const acceptedRun = await accepted(thread.id, input.requestId);
    abort.abort();
    await expect(streamed).rejects.toBeDefined();
    const context = await missionContext(database, acceptedRun.run.id);
    expect(context?.run.status).toBe('queued');
    expect(context?.mission.goal).toHaveLength(24000);
    expect(context?.run.checkpoint).toBeNull();
    expect(
      await database.orm
        .select()
        .from(queueOutbox)
        .where(eq(queueOutbox.runId, acceptedRun.run.id)),
    ).toHaveLength(1);
    const competing = await postChat(thread.id, {
      content: 'A competing turn.',
      requestId: randomUUID(),
    });
    expect(competing.status).toBe(409);
    await competing.body?.cancel();
    await queue.dispatch();
    await finished(acceptedRun.run.id);
    const replay = await readEvents(await postChat(thread.id, input));
    expect(replay.at(-1)).toMatchObject({ type: 'run.status', status: 'completed' });
  });

  it('keeps active inference running when its HTTP observer disconnects', async () => {
    const { thread } = await conversation();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    releases.add(release);
    let modelSignal: AbortSignal | undefined;
    const base = createFixtureRouter();
    router = {
      generateObject: base.generateObject,
      generate: async (input) => {
        modelSignal = input.signal;
        await gate;
        return base.generate(input);
      },
    };
    const input = { content: 'Finish after I close this page.', requestId: randomUUID() };
    const abort = controller();
    const streamed = readEvents(await postChat(thread.id, input, abort));
    const acceptedRun = await accepted(thread.id, input.requestId);
    await queue.dispatch();
    await vi.waitFor(() => expect(modelSignal).toBeDefined(), { timeout: 5000 });
    abort.abort();
    await expect(streamed).rejects.toBeDefined();
    expect(modelSignal!.aborted).toBe(false);
    expect((await missionContext(database, acceptedRun.run.id))?.run.status).toBe('running');
    release();
    await finished(acceptedRun.run.id);
  });

  it('returns a mission-linked approval state and replays its approved tool result without a new mission', async () => {
    const { thread } = await conversation();
    router = createFixtureRouter({
      toolName: 'time.fixture_alarm',
      args: { label: 'An approval fixture' },
    });
    const input = { content: 'Set an alarm through the fixture.', requestId: randomUUID() };
    const streamed = readEvents(await postChat(thread.id, input));
    const acceptedRun = await accepted(thread.id, input.requestId);
    await queue.dispatch();
    const events = await streamed;
    await finished(acceptedRun.run.id, 'waiting_approval');
    expect(events.at(-1)).toMatchObject({ type: 'run.status', status: 'waiting_approval' });
    expect(events.at(-1)).toHaveProperty(
      'message',
      expect.stringContaining(`/missions/${acceptedRun.mission.id}`),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.result',
        id: 'fixture-call-1',
        status: 'waiting_approval',
      }),
    );
    expect(alarms).toBe(0);
    const [approval] = await database.orm
      .select()
      .from(approvals)
      .where(eq(approvals.runId, acceptedRun.run.id));
    await decideApproval(
      database,
      userId,
      approval!.id,
      { version: approval!.version, action: 'approve' },
      registry,
      () => runtime.settings,
    );
    const resumed = readEvents(await postChat(thread.id, input));
    await queue.dispatch();
    const resumedEvents = await resumed;
    await finished(acceptedRun.run.id);
    expect(resumedEvents).toContainEqual({
      type: 'tool.result',
      id: 'fixture-call-1',
      name: 'time.fixture_alarm',
      output: { scheduled: true },
      status: 'done',
    });
    expect(alarms).toBe(1);
    expect(resumedEvents.at(-1)).toMatchObject({ type: 'run.status', status: 'completed' });
  });

  it('closes observers safely on server shutdown while the accepted mission continues through the queue', async () => {
    const { thread } = await conversation();
    const input = { content: 'Continue across the server restart.', requestId: randomUUID() };
    const streamed = readEvents(await postChat(thread.id, input));
    const acceptedRun = await accepted(thread.id, input.requestId);
    await app.close();
    const events = await streamed;
    expect(events.at(-1)).toMatchObject({ type: 'run.status', status: 'stream_interrupted' });
    expect(events.at(-1)).toHaveProperty(
      'message',
      expect.stringContaining(`/missions/${acceptedRun.mission.id}`),
    );
    expect((await missionContext(database, acceptedRun.run.id))?.run.status).toBe('queued');
    await queue.dispatch();
    await finished(acceptedRun.run.id);
  });
});
