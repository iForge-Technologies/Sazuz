import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshSettings } from '@sazuz/config/settings';
import {
  createMission,
  createProject,
  notifications,
  digests,
  notificationInterruptions,
  notificationFeedback,
  deliveryIntents,
  runs,
  workflowRuns,
  settingsHistory,
  costLedger,
  readSettings,
  workKey,
  jsonValue,
  recordHeartbeat,
  modelCatalog,
  saveSetting,
} from '@sazuz/db';
import { makeExecutionRequest, consumeExecutionSecret } from '@sazuz/vault';
import { notificationEvidenceSchema, notificationFeedbackSchema } from '@sazuz/core/calm';
import { workflowDefinitionSchema } from '@sazuz/core/workflows';
import { createNotificationRouter } from '../../packages/runtime/src/notifications.js';
import {
  reserveInterruption,
  interruptionCount,
  saveNotificationFeedback,
} from '../../packages/runtime/src/calm-store.js';
import { newCheckpoint } from '../../packages/runtime/src/loop.js';
import { durableCheckpointSchema } from '../../packages/runtime/src/durable-contracts.js';
import { saveWorkflow, reviewWorkflow, runWorkflow } from '../../packages/workflows/src/index.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { createBuiltinTools } from '../../packages/tools/src/index.js';
import { telegramBindings } from '@sazuz/db';
import { phaseFourFixture } from './phase-four-fixture.js';
import { createFixtureRouter } from './phase-three-runtime-worker.js';

describe('Phase 8 Calm Mode priority, durable interruption caps and feedback', () => {
  let fixture: Awaited<ReturnType<typeof phaseFourFixture>>;
  let settings = freshSettings();
  const now = new Date('2032-06-10T09:00:00Z');
  beforeAll(async () => {
    fixture = await phaseFourFixture(undefined, { maxConnections: 24 });
    await fixture.db.orm.insert(telegramBindings).values({
      id: workKey('tgb'),
      userId: fixture.userId,
      projectId: fixture.projectId,
      chatId: '1001',
      senderId: '1001',
    });
  });
  beforeEach(async () => {
    settings = freshSettings();
    settings.profile.value.quietStart = '00:00';
    settings.profile.value.quietEnd = '00:00';
    settings.profile.value.noiseBudget = 3;
    settings.profile.value.digestTimes = ['09:00'];
    settings.channels.value.urgent = 'telegram';
    settings.channels.value.digest = 'telegram';
    await fixture.db.orm.update(runs).set({ status: 'cancelled' });
    await fixture.db.orm.delete(notifications);
    await fixture.db.orm.delete(digests);
    await fixture.db.orm.delete(notificationInterruptions);
    await fixture.db.orm.delete(deliveryIntents);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  async function candidate(index = 0, extra: Partial<typeof notifications.$inferInsert> = {}) {
    const [row] = await fixture.db.orm
      .insert(notifications)
      .values({
        id: workKey('ntf'),
        userId: fixture.userId,
        projectId: fixture.projectId,
        eventKey: `burst:${randomUUID()}`,
        level: 'urgent',
        title: `Urgent ${index}`,
        body: `Fixture item ${index}`,
        createdAt: now,
        ...extra,
      })
      .returning();
    return row!;
  }
  const router = (deliver = vi.fn(() => Promise.resolve({ delivered: true }))) =>
    createNotificationRouter({ database: fixture.db, getSettings: () => settings, deliver });
  async function completedRun(privateOnly = false) {
    const mission = await createMission(
      fixture.db,
      fixture.userId,
      {
        projectId: fixture.projectId,
        agent: 'writer',
        goal: 'A completed source for Calm Mode',
        requestId: randomUUID(),
      },
      { maxSteps: 20, maxCostUsd: 0.5, maxWallTimeSeconds: 180 },
    );
    const loop = newCheckpoint([{ role: 'user', content: 'Completed work' }]);
    loop.privateOnly = privateOnly;
    const checkpoint = durableCheckpointSchema.parse({
      version: 1,
      loop,
      phase: 'direct',
      agentId: 'writer',
      plan: null,
      taskIndex: 0,
      results: [],
    });
    await fixture.db.orm
      .update(runs)
      .set({ status: 'completed', checkpoint: jsonValue(checkpoint) })
      .where(eq(runs.id, mission.run.id));
    return mission.run.id;
  }
  it('reserves at most three slots under ten concurrent admissions', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        reserveInterruption(fixture.db, {
          deliveryId: 'concurrent:' + i,
          userId: fixture.userId,
          day: '2032-06-10',
          cap: 3,
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await interruptionCount(fixture.db, fixture.userId, '2032-06-10')).toBe(3);
    const [first] = await fixture.db.orm.select().from(notificationInterruptions);
    expect(
      await reserveInterruption(fixture.db, {
        deliveryId: first!.deliveryId,
        userId: fixture.userId,
        day: first!.day,
        cap: 3,
      }),
    ).toBe(true);
  });
  it('keeps a ten-item urgent burst at three interruptions including the later digest, across routers and restart', async () => {
    for (let i = 0; i < 10; i++) await candidate(i);
    const delivered = vi.fn(() => Promise.resolve({ delivered: true }));
    await Promise.all([router(delivered).tick(now), router(delivered).tick(now)]);
    await router(delivered).tick(new Date('2032-06-10T18:00:00Z'));
    expect(delivered).toHaveBeenCalledTimes(3);
    const all = await fixture.db.orm.select().from(notifications);
    expect(all).toHaveLength(10);
    expect(all.filter((row) => row.status === 'digested')).toHaveLength(7);
    const [digest] = await fixture.db.orm.select().from(digests);
    expect(digest).toMatchObject({ itemCount: 7, deliveryStatus: 'pending' });
    expect(await interruptionCount(fixture.db, fixture.userId, '2032-06-10')).toBe(3);
    await router(delivered).tick(new Date('2032-06-11T09:00:00Z'));
    expect(delivered).toHaveBeenCalledTimes(4);
    expect(await interruptionCount(fixture.db, fixture.userId, '2032-06-11')).toBe(1);
  });
  it('counts a digest against the same daily cap before urgent sends and never replays uncertainty', async () => {
    await candidate(0, { level: 'normal', title: 'Digest first' });
    const delivered = vi.fn(() => Promise.resolve({ delivered: true }));
    await router(delivered).tick(now);
    expect(delivered).toHaveBeenCalledOnce();
    for (let i = 0; i < 4; i++) await candidate(i);
    await router(delivered).tick(now);
    expect(delivered).toHaveBeenCalledTimes(3);
    await fixture.db.orm
      .update(notifications)
      .set({ status: 'pending' })
      .where(eq(notifications.status, 'delivered'));
    const [attempt] = await fixture.db.orm
      .select()
      .from(deliveryIntents)
      .where(sql`${deliveryIntents.id} LIKE 'notification:%'`)
      .limit(1);
    await fixture.db.orm
      .update(deliveryIntents)
      .set({ status: 'intent' })
      .where(eq(deliveryIntents.id, attempt!.id));
    await router(delivered).tick(now);
    expect(delivered).toHaveBeenCalledTimes(3);
    expect(await interruptionCount(fixture.db, fixture.userId, '2032-06-10')).toBe(3);
    expect(
      (await fixture.db.orm.select().from(notifications)).filter(
        (row) => row.status === 'uncertain',
      ),
    ).toHaveLength(1);
    const urgentDigestIds = (await fixture.db.orm.select().from(digests)).flatMap(
      (digest) => digest.notificationIds as string[],
    );
    expect(urgentDigestIds).not.toContain(attempt!.id.slice('notification:'.length));
  });
  it('retains uncertain sends and merges new overflow into the existing unsent digest', async () => {
    settings.profile.value.noiseBudget = 1;
    await candidate();
    const deliver = vi.fn(() => Promise.reject(new Error('Lost acknowledgement after send')));
    await router(deliver).tick(now);
    await candidate(1);
    await router(deliver).tick(now);
    await candidate(2);
    await router(deliver).tick(now);
    expect(deliver).toHaveBeenCalledOnce();
    expect(
      (await fixture.db.orm.select().from(notifications)).filter(
        (row) => row.status === 'uncertain',
      ),
    ).toHaveLength(1);
    const groups = await fixture.db.orm.select().from(digests);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.itemCount).toBe(2);
  });
  it('lets critical bypass quiet hours while enforcing the cap and exact paired project', async () => {
    settings.profile.value.quietStart = '22:00';
    settings.profile.value.quietEnd = '08:00';
    settings.profile.value.noiseBudget = 1;
    await candidate(0, { critical: true });
    await candidate(1, { critical: true });
    const deliver = vi.fn(() => Promise.resolve({ delivered: true }));
    await router(deliver).tick(new Date('2032-06-10T23:00:00Z'));
    expect(deliver).toHaveBeenCalledOnce();
    await router(deliver).tick(new Date('2032-06-10T23:30:00Z'));
    expect(deliver).toHaveBeenCalledOnce();
    const other = await createProject(fixture.db, fixture.userId, {
      name: 'Unpaired private project',
    });
    await candidate(3, {
      projectId: other.id,
      title: 'Other project private item',
      critical: true,
    });
    await router(deliver).tick(new Date('2032-06-11T23:00:00Z'));
    expect(JSON.stringify(deliver.mock.calls)).not.toContain('Other project private item');
  });
  it('classifies rule signals, leaves low items searchable, and learns idempotent project-scoped feedback with hot reload', async () => {
    settings.profile.value.vipSenders = ['boss@example.test'];
    const row = await candidate(0, {
      title: 'Invoice due',
      level: 'normal',
      signals: {
        sender: 'boss@example.test',
        deadlineAt: '2032-06-10T22:00:00Z',
        moneyInvolved: true,
      },
    });
    const low = await candidate(1, { title: 'Background archival status', level: 'low' });
    await router().tick(now);
    const [scored] = await fixture.db.orm
      .select()
      .from(notifications)
      .where(eq(notifications.id, row.id));
    expect(notificationEvidenceSchema.parse(scored!.priorityEvidence)).toMatchObject({
      score: 80,
      model: 'rules',
    });
    expect(
      (await fixture.db.orm.select().from(notifications).where(eq(notifications.id, low.id)))[0]
        ?.status,
    ).toBe('logged');
    const search = await fixture.request('GET', '/api/notifications?q=archival');
    expect(search.body).toContain(low.id);
    expect(search.body).not.toContain(row.id);
    const version = (await readSettings(fixture.db)).profile.version;
    const vote = { requestId: randomUUID(), kind: 'not_important' as const };
    expect(
      (await fixture.request('POST', `/api/notifications/${row.id}/feedback`, vote, false))
        .statusCode,
    ).toBe(401);
    const first = await fixture.request('POST', `/api/notifications/${row.id}/feedback`, vote);
    expect(first.statusCode, first.body).toBe(200);
    const receipt = notificationFeedbackSchema.parse(first.json());
    expect(receipt).toMatchObject({ bias: -20, settingsVersion: version + 1 });
    expect(await saveNotificationFeedback(fixture.db, fixture.userId, row.id, vote)).toEqual(
      receipt,
    );
    const repeated = await saveNotificationFeedback(fixture.db, fixture.userId, row.id, {
      ...vote,
      requestId: randomUUID(),
    });
    expect(repeated.settingsVersion).toBe(receipt.settingsVersion);
    await vi.waitFor(() => expect(fixture.runtime.settings.profile.version).toBe(version + 1));
    const [history] = await fixture.db.orm
      .select()
      .from(settingsHistory)
      .where(
        and(eq(settingsHistory.namespace, 'profile'), eq(settingsHistory.version, version + 1)),
      );
    expect(history?.actorId).toBe(fixture.userId);
    expect(
      await fixture.db.orm
        .select()
        .from(notificationFeedback)
        .where(eq(notificationFeedback.notificationId, row.id)),
    ).toHaveLength(2);
    await expect(
      saveNotificationFeedback(fixture.db, 'different-owner', row.id, {
        ...vote,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'MISSION_NOT_FOUND' });
    await expect(
      saveNotificationFeedback(fixture.db, fixture.userId, low.id, vote),
    ).rejects.toMatchObject({ code: 'MISSION_CONFLICT' });
    const sooner = await saveNotificationFeedback(fixture.db, fixture.userId, row.id, {
      requestId: randomUUID(),
      kind: 'sooner',
    });
    expect(sooner.bias).toBe(20);
    settings.profile.value = (await readSettings(fixture.db)).profile.value;
    const learned = await candidate(2);
    await router().tick(now);
    const [saved] = await fixture.db.orm
      .select()
      .from(notifications)
      .where(eq(notifications.id, learned.id));
    expect(notificationEvidenceSchema.parse(saved!.priorityEvidence).bias).toBe(20);
    const pendingRun = await completedRun();
    const pending = await candidate(4, { sourceRunId: pendingRun, title: 'Unclassified source' });
    await saveNotificationFeedback(fixture.db, fixture.userId, pending.id, {
      requestId: randomUUID(),
      kind: 'not_important',
    });
    expect((await readSettings(fixture.db)).profile.value.priorityRules).toContainEqual({
      projectId: fixture.projectId,
      source: 'agent:writer',
      bias: -20,
    });
  });
  it('accounts tool-free private Fast classification once and falls back after a billed failure', async () => {
    const runId = await completedRun(true);
    const row = await candidate(0, {
      sourceRunId: runId,
      level: 'normal',
      title: 'Source summary',
      eventKey: `run:${runId}:completed`,
    });
    const calls = vi.fn();
    const classifier = {
      workerId: workKey('wrk'),
      router: () =>
        createFixtureRouter({
          plan: { priority: 'low', reason: 'No timely action' },
          costUsd: 0.001,
          onGenerate: calls,
        }),
    };
    const service = createNotificationRouter({
      database: fixture.db,
      getSettings: () => settings,
      deliver: vi.fn(),
      classifier,
    });
    await service.tick(new Date());
    await service.tick(new Date());
    expect(calls).toHaveBeenCalledOnce();
    expect(calls.mock.calls[0]?.[0]).toMatchObject({ role: 'fast', privateOnly: true, tools: [] });
    expect(
      await fixture.db.orm.select().from(costLedger).where(eq(costLedger.runId, runId)),
    ).toHaveLength(1);
    const [saved] = await fixture.db.orm
      .select()
      .from(notifications)
      .where(eq(notifications.id, row.id));
    expect(notificationEvidenceSchema.parse(saved!.priorityEvidence)).toMatchObject({
      model: 'classified',
      score: 0,
    });
    const failed = await candidate(1, {
      sourceRunId: runId,
      level: 'normal',
      title: 'Another summary',
    });
    const broken = createNotificationRouter({
      database: fixture.db,
      getSettings: () => settings,
      deliver: vi.fn(),
      classifier: {
        ...classifier,
        router: () => ({
          generateObject: async (request, schema) => {
            await classifier.router().generateObject(request, schema);
            throw new Error('Failed after usage');
          },
        }),
      },
    });
    await broken.tick(new Date());
    await broken.tick(new Date());
    const [fallback] = await fixture.db.orm
      .select()
      .from(notifications)
      .where(eq(notifications.id, failed.id));
    expect(notificationEvidenceSchema.parse(fallback!.priorityEvidence).model).toBe('fallback');
    expect(calls).toHaveBeenCalledTimes(2);
  });
  it('never classifies deterministic workflow completions and never retries interrupted classifications', async () => {
    const graph = workflowDefinitionSchema.parse({
      name: 'No inference',
      nodes: [
        {
          id: 'start',
          label: 'Manual',
          position: { x: 0, y: 0 },
          action: { kind: 'trigger', trigger: { kind: 'manual' } },
        },
      ],
      edges: [],
    });
    const saved = await saveWorkflow(fixture.db, fixture.userId, null, {
      projectId: fixture.projectId,
      expectedVersion: 0,
      definition: graph,
    });
    await reviewWorkflow(
      fixture.db,
      fixture.userId,
      saved.id,
      { expectedVersion: saved.version, revision: 1, enabled: false },
      settings,
    );
    const run = await runWorkflow(
      fixture.db,
      fixture.userId,
      saved.id,
      { revision: 1, requestId: randomUUID() },
      settings,
    );
    const model = vi.fn();
    const executor = createDurableExecutor({
      database: fixture.db,
      workerId: 'calm-model-free',
      dataDir: fixture.directory,
      getSettings: () => settings,
      tools: createBuiltinTools(),
      router: () => createFixtureRouter({ onGenerate: model }),
    });
    await executor.execute(run.id);
    const service = createNotificationRouter({
      database: fixture.db,
      getSettings: () => settings,
      deliver: vi.fn(),
      classifier: {
        workerId: workKey('wrk'),
        router: () =>
          createFixtureRouter({
            plan: { priority: 'urgent', reason: 'Should never be invoked' },
            onGenerate: model,
          }),
      },
    });
    await service.tick(new Date());
    expect(model).not.toHaveBeenCalled();
    expect(
      await fixture.db.orm.select().from(costLedger).where(eq(costLedger.runId, run.id)),
    ).toHaveLength(0);
    const sourceRunId = await completedRun();
    const row = await candidate(0, {
      sourceRunId,
      eventKey: `run:${sourceRunId}:completed`,
      classificationStatus: 'running',
      classificationClaim: randomUUID(),
      classificationAt: new Date(Date.now() - 30000),
    });
    await service.tick(new Date());
    expect(model).not.toHaveBeenCalled();
    expect(
      notificationEvidenceSchema.parse(
        (await fixture.db.orm.select().from(notifications).where(eq(notifications.id, row.id)))[0]!
          .priorityEvidence,
      ).model,
    ).toBe('fallback');
  });
  it('binds classifier credentials to the notification claim, worker, privacy and source model-free flag', async () => {
    const sourceRunId = await completedRun();
    const workerId = workKey('wrk'),
      claimKey = randomUUID();
    await recordHeartbeat(fixture.db, workerId);
    const row = await candidate(0, {
      sourceRunId,
      classificationStatus: 'running',
      classificationWorker: workerId,
      classificationClaim: claimKey,
      classificationAt: new Date(),
    });
    const secret = await fixture.runtime.vault.create({
      name: 'Calm fixture key',
      value: 'calm-vault-canary-712845695',
      createdBy: fixture.userId,
    });
    const provider = {
      id: 'calm_fixture',
      name: 'Calm fixture',
      kind: 'openai-compatible',
      baseUrl: 'https://model.example.test/v1',
      locality: 'cloud',
      enabled: true,
      secretRef: secret.reference,
    };
    const original = await readSettings(fixture.db);
    await saveSetting(fixture.db, {
      namespace: 'providers',
      expectedVersion: original.providers.version,
      actorId: fixture.userId,
      value: { items: [provider] },
    });
    await fixture.db.orm
      .insert(modelCatalog)
      .values({ providerId: 'calm_fixture', modelId: 'fast', value: {} });
    const identity = {
      workspaceId: (await fixture.runtime.state()).workspaceId,
      workerId,
      scope: 'notification' as const,
      runId: null,
      claimKey,
      executionId: row.id,
      reference: secret.reference as string | null,
    };
    const send = async (overrides: Partial<typeof identity> = {}) => {
      const signed = makeExecutionRequest(fixture.runtime.plumbing.operatorKey, {
        ...identity,
        ...overrides,
      });
      return fixture.app.inject({
        method: 'POST',
        url: '/internal/execution',
        headers: { 'x-sazuz-worker-signature': signed.signature },
        payload: signed.request,
      });
    };
    const signed = makeExecutionRequest(fixture.runtime.plumbing.operatorKey, identity);
    const capsule = await fixture.app.inject({
      method: 'POST',
      url: '/internal/execution',
      headers: { 'x-sazuz-worker-signature': signed.signature },
      payload: signed.request,
    });
    expect(capsule.statusCode, capsule.body).toBe(200);
    expect(capsule.body).not.toContain('calm-vault-canary-712845695');
    expect(
      await consumeExecutionSecret(
        fixture.runtime.plumbing.operatorKey,
        signed.request,
        capsule.json(),
        (value) => Promise.resolve(value === 'calm-vault-canary-712845695'),
      ),
    ).toBe(true);
    await fixture.db.orm
      .update(notifications)
      .set({ privateOnly: true })
      .where(eq(notifications.id, row.id));
    expect((await send()).statusCode).toBe(403);
    await fixture.db.orm
      .update(notifications)
      .set({ privateOnly: false })
      .where(eq(notifications.id, row.id));
    expect((await send({ claimKey: randomUUID() })).statusCode).toBe(403);
    await fixture.db.orm
      .update(notifications)
      .set({ classificationStatus: 'done' })
      .where(eq(notifications.id, row.id));
    expect((await send()).statusCode).toBe(403);
    await fixture.db.orm
      .update(notifications)
      .set({ classificationStatus: 'running', classificationAt: new Date(Date.now() - 16000) })
      .where(eq(notifications.id, row.id));
    expect((await send()).statusCode).toBe(403);
    // Reusing an ordinary run claim cannot authorize background classification.
    expect((await send({ scope: 'notification', executionId: sourceRunId })).statusCode).toBe(403);
    const [deterministic] = await fixture.db.orm.select().from(workflowRuns).limit(1);
    await fixture.db.orm
      .update(runs)
      .set({ status: 'completed' })
      .where(eq(runs.id, deterministic!.runId));
    await fixture.db.orm
      .update(notifications)
      .set({ sourceRunId: deterministic!.runId, classificationAt: new Date() })
      .where(eq(notifications.id, row.id));
    expect((await send()).statusCode).toBe(403);
    expect(fixture.logLines.join('')).not.toContain('calm-vault-canary-712845695');
  });
});
