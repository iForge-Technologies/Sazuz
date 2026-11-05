import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  browserSessions,
  browserActions,
  getMission,
  recordHeartbeat,
  runs,
  toolCalls,
  learnedRepairs,
  learnedReplays,
  costLedger,
  runSteps,
  workKey,
} from '@sazuz/db';
import { learnedVersionSchema, type LearnedVersion } from '@sazuz/core/learning';
import { learnedReplaySchema, learnedRepairSchema } from '@sazuz/core/learning-replay';
import { createBrowserTools } from '@sazuz/browser';
import { browserRpcResultSchema, browserWorkerRequestSchema } from '@sazuz/browser/protocol';
import {
  compileRecording,
  insertLearnedVersion,
  learnedVersion,
  reviseLearnedSkill,
} from '../../packages/skills/src/index.js';
import { ToolRegistry } from '../../packages/tools/src/registry.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { decideApproval } from '../../packages/runtime/src/durable-store.js';
import { durableCheckpointSchema } from '../../packages/runtime/src/durable-contracts.js';
import { createFixtureRouter } from './phase-three-runtime-worker.js';
import { learningFixture } from './phase-nine-fixture.js';
import type { GenerateRequest } from '../../packages/llm/src/contracts.js';

describe('Phase 9 durable learned replay on actual Chromium', { timeout: 120000 }, () => {
  let f: Awaited<ReturnType<typeof learningFixture>>;
  let learned: LearnedVersion, profileId: string;
  const inputs = {
    project: 'New project',
    client: 'New client',
    category: 'Alpha',
    notes: 'New notes',
  };
  beforeAll(async () => {
    f = await learningFixture();
    const demo = await f.eightSteps();
    profileId = demo.run.profile.id;
    const program = compileRecording(demo.recording.site, demo.recording.events, {
      requestId: randomUUID(),
      name: 'new-project',
      loops: [],
      parameters: Object.fromEntries(
        demo.recording.events
          .filter((event) => ['fill', 'select'].includes(event.kind))
          .map((event) => [event.id, event.target!.name.toLowerCase()]),
      ),
    });
    const skill = await f.db.orm.transaction((tx) =>
      insertLearnedVersion(tx, f.userId, {
        expectedRevision: 0,
        name: 'new-project',
        description: 'Create a project.',
        program,
        projectId: f.projectId,
        recordingId: demo.record.id,
        privateOnly: true,
        enabled: true,
      }),
    );
    learned = await learnedVersion(f.db, f.userId, skill.id);
    await f.client({ mode: 'close', sessionId: demo.sessionId });
  });
  afterEach(async () => {
    f.resetDom();
    for (const sessionId of f.service.engine.sessions.keys())
      await f.client({ mode: 'close', sessionId });
  });
  afterAll(async () => {
    await f?.close();
  });
  async function start(overrides: Record<string, unknown> = {}) {
    const body = {
      requestId: randomUUID(),
      revision: learned.skill.revision,
      inputs,
      mode: 'live',
      profileId,
      allowRepair: true,
      ...overrides,
    };
    const response = await f.request(
      'POST',
      `/api/skills/learned/${learned.skill.id}/replays`,
      body,
    );
    expect(response.statusCode, response.body).toBe(200);
    return { body, value: learnedReplaySchema.parse(response.json()) };
  }
  function worker(options: { loseAcknowledgement?: boolean; repair?: boolean } = {}) {
    let lost = false;
    const generated = vi.fn();
    const tools = new ToolRegistry(
      createBrowserTools({
        async request(ctx, operation, args, verify) {
          await recordHeartbeat(f.db, f.workerId);
          const message = browserWorkerRequestSchema.parse({
            workerId: f.workerId,
            claimKey: ctx.claimKey,
            runId: ctx.runId,
            callKey: ctx.idempotencyKey,
            command: { operation, args },
            verify,
            nonce: randomUUID(),
            expiresAt: Date.now() + 45000,
          });
          const result = browserRpcResultSchema.parse(await f.gateway.execute(message));
          if (
            options.loseAcknowledgement &&
            !lost &&
            !verify &&
            operation === 'click' &&
            result.observation?.text.includes('Project saved.')
          ) {
            lost = true;
            throw new Error(
              'Fixture lost the acknowledgement after the browser saved its receipt.',
            );
          }
          return result;
        },
      }),
    );
    const executor = createDurableExecutor({
      database: f.db,
      workerId: f.workerId,
      dataDir: f.directory,
      getSettings: () => f.runtime.settings,
      tools,
      router: () => ({
        generate: () => {
          generated();
          return Promise.reject(new Error('Deterministic replay must not infer.'));
        },
        generateObject: async <T>(
          request: GenerateRequest,
          schema: z.ZodType<T>,
          limits?: { maxAttempts?: 1 | 2 },
        ) => {
          generated();
          expect(options.repair).toBe(true);
          expect(limits?.maxAttempts).toBe(1);
          expect(request.privateOnly).toBe(true);
          expect(request.tools).toEqual([]);
          const text = request.messages.at(-1)!.content;
          const data = z
            .object({ elements: z.array(z.object({ ref: z.string(), name: z.string() })) })
            .parse(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
          const target = data.elements.find((item) => item.name === 'Continue to summary');
          return createFixtureRouter({
            plan: {
              ref: target?.ref ?? null,
              reason: 'The renamed review control opens the project summary.',
            },
            costUsd: 0.001,
          }).generateObject(request, schema);
        },
      }),
    });
    async function advance(runId: string) {
      await executor.execute(runId);
      return (await f.db.orm.select().from(runs).where(eq(runs.id, runId)))[0]!;
    }
    async function drain(runId: string) {
      let recoveries = 0;
      for (let i = 0; i < 35; i++) {
        const run = await advance(runId);
        if (run.status !== 'waiting_approval') return run;
        const detail = (await getMission(f.db, f.userId, run.missionId))!;
        const approval = detail.approvals.find((item) => item.status === 'pending');
        expect(approval, run.reason ?? 'pending action').toBeDefined();
        if (approval!.kind === 'uncertain' && options.loseAcknowledgement) {
          const pending = durableCheckpointSchema.parse(run.checkpoint).loop;
          const [receipt] = await f.db.orm
            .select()
            .from(browserActions)
            .where(eq(browserActions.key, `${run.id}:${pending.step}:${pending.nextCall}`));
          expect(
            receipt?.status,
            `Recovery requires a completed browser receipt for ${approval!.toolName}`,
          ).toBe('done');
          expect(++recoveries).toBeLessThanOrEqual(3);
          await f.db.orm.update(runs).set({ status: 'queued' }).where(eq(runs.id, runId));
        } else
          await decideApproval(
            f.db,
            f.userId,
            approval!.id,
            { action: 'approve', version: approval!.version },
            tools,
            () => f.runtime.settings,
          );
      }
      throw new Error('Fixture replay did not finish within its approval bound.');
    }
    return {
      advance,
      drain,
      generated,
      tools,
      get lost() {
        return lost;
      },
    };
  }
  it('rehearses with zero network/model/effects and runs all eight recorded actions with new inputs', async () => {
    const beforeRequests = f.requests,
      beforeSubmissions = f.submissions.length;
    const dry = await start({ mode: 'rehearsal' });
    expect(dry.value.status).toBe('simulated');
    expect(dry.value.evidence).toHaveLength(8);
    expect(dry.value.runId).toBeNull();
    expect(f.requests).toBe(beforeRequests);
    const run = await start();
    const replay = await f.request(
      'POST',
      `/api/skills/learned/${learned.skill.id}/replays`,
      run.body,
    );
    expect(learnedReplaySchema.parse(replay.json()).id).toBe(run.value.id);
    const w = worker(),
      finished = await w.drain(run.value.runId!);
    expect(finished.status, finished.reason ?? 'run').toBe('completed');
    expect(w.generated).not.toHaveBeenCalled();
    expect(f.submissions).toHaveLength(beforeSubmissions + 1);
    expect(f.submissions.at(-1)).toEqual({ ...inputs, confirmed: 'on' });
    const effects = await f.db.orm.select().from(toolCalls).where(eq(toolCalls.runId, finished.id));
    expect(effects.filter((call) => call.status === 'done')).toHaveLength(17);
    expect(
      await f.db.orm.select().from(costLedger).where(eq(costLedger.runId, finished.id)),
    ).toHaveLength(0);
    expect(
      (await f.db.orm.select().from(runSteps).where(eq(runSteps.runId, finished.id)))
        .filter((step) => step.kind === 'plan')
        .every((step) => step.providerId === null),
    ).toBe(true);
    expect(durableCheckpointSchema.parse(finished.checkpoint).learned?.index).toBe(8);
  });
  it('recovers a lost acknowledgement from the browser receipt and submits exactly once', async () => {
    const before = f.submissions.length,
      run = await start(),
      w = worker({ loseAcknowledgement: true });
    const result = await w.drain(run.value.runId!);
    expect(result.status, result.reason ?? 'recovery').toBe('completed');
    expect(w.lost).toBe(true);
    expect(f.submissions).toHaveLength(before + 1);
    await w.advance(result.id);
    expect(f.submissions).toHaveLength(before + 1);
    expect(w.generated).not.toHaveBeenCalled();
  });
  it('repairs a deliberately changed DOM once and creates a new revision only after explicit patch review', async () => {
    f.changeDom();
    const run = await start(),
      w = worker({ repair: true }),
      before = f.submissions.length;
    const result = await w.drain(run.value.runId!);
    expect(result.status, result.reason ?? 'repair').toBe('completed');
    expect(w.generated).toHaveBeenCalledTimes(1);
    expect(f.submissions).toHaveLength(before + 1);
    const [patch] = await f.db.orm
      .select()
      .from(learnedRepairs)
      .where(eq(learnedRepairs.replayId, run.value.id));
    expect(patch?.status).toBe('proposed');
    expect(patch?.costUsd).toBeCloseTo(0.001);
    const pinned = (
      await f.db.orm.select().from(learnedReplays).where(eq(learnedReplays.id, run.value.id))
    )[0]!;
    expect(pinned.revision).toBe(1);
    expect((await learnedVersion(f.db, f.userId, learned.skill.id)).skill.revision).toBe(1);
    const decision = { action: 'accept', expectedRevision: 1 };
    const response = await f.request('POST', `/api/skills/patches/${patch!.id}/decision`, decision);
    expect(response.statusCode, response.body).toBe(200);
    expect(learnedRepairSchema.parse(response.json()).acceptedRevision).toBe(2);
    expect(
      (await f.request('POST', `/api/skills/patches/${patch!.id}/decision`, decision)).json(),
    ).toEqual(response.json());
    expect((await learnedVersion(f.db, f.userId, learned.skill.id, 1)).programHash).toBe(
      learned.programHash,
    );
    expect((await learnedVersion(f.db, f.userId, learned.skill.id, 2)).programHash).not.toBe(
      learned.programHash,
    );
    // Keep testing the explicitly pinned original revision.
  });
  it('fails closed on ambiguous locators without inference or submission', async () => {
    f.duplicateTarget();
    const before = f.submissions.length,
      run = await start(),
      w = worker({ repair: true });
    const result = await w.drain(run.value.runId!);
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('ambiguous');
    expect(f.submissions).toHaveLength(before);
    expect(w.generated).not.toHaveBeenCalled();
  });
  it('retains an interrupted repair without inference or another submission', async () => {
    f.changeDom();
    const before = f.submissions.length,
      run = await start(),
      w = worker({ repair: true });
    await f.db.orm.insert(learnedRepairs).values({
      id: workKey('lfix'),
      replayId: run.value.id,
      actionIndex: 4,
      stepId: 's5',
      status: 'generating',
      createdAt: new Date(Date.now() - 120000),
    });
    const result = await w.drain(run.value.runId!);
    expect(result.status).toBe('failed');
    expect(w.generated).not.toHaveBeenCalled();
    expect(f.submissions).toHaveLength(before);
    const response = await f.request('GET', `/api/skills/learned/${learned.skill.id}/repairs`);
    expect(response.statusCode, response.body).toBe(200);
    const receipt = z
      .array(learnedRepairSchema)
      .parse(response.json())
      .find((row) => row.replayId === run.value.id);
    expect(receipt?.status).toBe('failed');
    expect(receipt?.reason).toContain('interrupted');
  });
  it('enforces input bounds, owner/CSRF scope, current disabled state, and run step caps', async () => {
    const path = `/api/skills/learned/${learned.skill.id}/replays`;
    const body = { requestId: randomUUID(), revision: 1, inputs, mode: 'live', profileId };
    expect((await f.request('POST', path, body, false)).statusCode).toBe(401);
    expect((await f.request('POST', path, body, true, 'https://evil.example')).statusCode).toBe(
      403,
    );
    expect((await f.request('POST', path, { ...body, inputs: { bad: 'input' } })).statusCode).toBe(
      400,
    );
    const capped = await start(),
      w = worker();
    await f.db.orm
      .update(runs)
      .set({ limits: { maxSteps: 1, maxCostUsd: 0.5, maxWallTimeSeconds: 600 } })
      .where(eq(runs.id, capped.value.runId!));
    expect((await w.drain(capped.value.runId!)).status).toBe('budget_exceeded');
    const run = await start();
    const paused = await w.advance(run.value.runId!);
    expect(paused.status).toBe('waiting_approval');
    const current = await learnedVersion(f.db, f.userId, learned.skill.id);
    const revised = await reviseLearnedSkill(f.db, f.userId, learned.skill.id, {
      expectedRevision: current.skill.revision,
      description: current.skill.description,
      program: current.program,
      enabled: false,
    });
    expect(learnedVersionSchema.parse(revised).skill.enabled).toBe(false);
    expect((await f.request('POST', path, { ...body, requestId: randomUUID() })).statusCode).toBe(
      403,
    );
    const approval = (await getMission(f.db, f.userId, paused.missionId))!.approvals.find(
      (item) => item.status === 'pending',
    )!;
    await expect(
      decideApproval(
        f.db,
        f.userId,
        approval.id,
        { action: 'approve', version: approval.version },
        w.tools,
        () => f.runtime.settings,
      ),
    ).rejects.toThrow();
    expect(
      await f.db.orm.select().from(browserSessions).where(eq(browserSessions.runId, paused.id)),
    ).toHaveLength(0);
    expect(
      await f.db.orm
        .select()
        .from(toolCalls)
        .where(and(eq(toolCalls.runId, paused.id), eq(toolCalls.status, 'done'))),
    ).toHaveLength(0);
  });
});
