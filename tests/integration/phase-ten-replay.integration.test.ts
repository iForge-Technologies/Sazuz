import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { freshSettings, type SettingsDocument } from '@sazuz/config/settings';
import {
  createMission,
  runSteps,
  runs,
  runReplays,
  costLedger,
  toolCalls,
  notifications,
  jsonValue,
} from '@sazuz/db';
import { runDetailSchema, forkInputSchema } from '@sazuz/core/replay';
import {
  createDurableExecutor,
  forkRun,
  runDetail,
  collectNotifications,
} from '../../packages/runtime/src/index.js';
import { ToolRegistry, defineTool } from '../../packages/tools/src/index.js';
import type { GenerateRequest, GenerateResult } from '../../packages/llm/src/contracts.js';
import { phaseFourFixture } from './phase-four-fixture.js';
import { registerPhaseTen } from '../../apps/server/src/phase-ten.js';
import { decideApproval } from '../../packages/runtime/src/durable-store.js';
import { durableCheckpointSchema } from '../../packages/runtime/src/durable-contracts.js';

describe('Phase 10 isolated durable forks', () => {
  let f: Awaited<ReturnType<typeof phaseFourFixture>>;
  let settings: SettingsDocument;
  const requests: GenerateRequest[] = [];
  const live = vi.fn(() => Promise.resolve({ text: 'recorded fixture' }));
  const complete = vi.fn(() => Promise.resolve());
  const tools = new ToolRegistry(
    ['read', 'write', 'send'].map((effect) =>
      defineTool({
        name: `files.${effect}`,
        description: `Fixture ${effect}`,
        effect,
        scope: effect === 'send' ? 'external' : 'internal',
        untrusted: true,
        input: z.strictObject({ path: z.string() }),
        output: z.strictObject({ text: z.string() }),
        run: live,
      }),
    ),
  );
  const makeExecutor = (registry = tools) =>
    createDurableExecutor({
      database: f.db,
      workerId: 'phase10-fixture',
      dataDir: f.directory,
      tools: registry,
      getSettings: () => settings,
      secret: () => Promise.reject(new Error('Replay cannot resolve tool credentials')),
      complete,
      router: () => ({
        async generate(request) {
          requests.push(request);
          const observed = request.messages
            .filter((message) => message.role === 'tool')
            .map((message) => message.name);
          const action = !observed.includes('files.read')
            ? 'read'
            : !observed.includes('files.write')
              ? 'write'
              : null;
          const response: GenerateResult = {
            providerId: request.selectedModel?.providerId ?? 'fixture',
            modelId: request.selectedModel?.modelId ?? 'original',
            text: action ? 'Check the fixture.' : 'Comparable fixture summary.',
            toolCalls: action
              ? [{ id: `call-${action}`, name: `files.${action}`, args: { path: 'notes.txt' } }]
              : [],
            costUsd: 0.01,
            costEstimated: false,
            latencyMs: 3,
            usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, source: 'provider' },
            finishReason: action ? 'tool-calls' : 'stop',
          };
          await request.onUsage?.({ ...response, status: 'completed' });
          return response;
        },
        generateObject: () =>
          Promise.reject(new Error('Replay cannot make implicit planning/learning calls')),
      }),
    });
  beforeAll(async () => {
    f = await phaseFourFixture(registerPhaseTen);
    settings = freshSettings();
    settings.providers.value.items = [
      {
        id: 'fixture',
        name: 'Fixture',
        kind: 'ollama',
        baseUrl: 'http://localhost:11434',
        secretRef: null,
        locality: 'local',
        enabled: true,
      },
    ];
    settings.budgets.value.perRunUsd = 1;
  });
  afterAll(async () => {
    await f?.close();
  });
  it('forks before a model step, pins another model, and never dispatches a live tool on resume', async () => {
    const mission = await createMission(
      f.db,
      f.userId,
      {
        projectId: f.projectId,
        goal: 'Read and save the fixture',
        agent: 'writer',
        requestId: randomUUID(),
      },
      { maxSteps: 10, maxCostUsd: 1, maxWallTimeSeconds: 120 },
    );
    // Create source evidence with the real loop while the completion hook is explicitly absent.
    const executor = makeExecutor();
    await executor.execute(mission.run.id);
    const original = await runDetail(f.db, f.userId, mission.run.id);
    const selected = original.steps.filter((step) => step.kind === 'assistant')[1]!;
    const sourceBefore = await f.db.orm
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, mission.run.id));
    const input = forkInputSchema.parse({
      stepId: selected.id,
      requestId: randomUUID(),
      model: { providerId: 'fixture', modelId: 'alternative' },
    });
    const fork = await forkRun(f.db, f.userId, mission.run.id, input, settings);
    const callsBefore = live.mock.calls.length;
    const completionsBefore = complete.mock.calls.length;
    await executor.execute(fork.run.id);
    await executor.execute(fork.run.id);
    const completed = await runDetail(f.db, f.userId, fork.run.id);
    expect(completed.run.status).toBe('completed');
    expect(
      completed.steps
        .filter((step) => step.modelId)
        .every((step) => step.modelId === 'alternative'),
    ).toBe(true);
    expect(completed.steps.at(-1)?.content).toContain('Comparable');
    expect(live).toHaveBeenCalledTimes(callsBefore);
    expect(complete).toHaveBeenCalledTimes(completionsBefore);
    expect(
      await f.db.orm.select().from(runSteps).where(eq(runSteps.runId, mission.run.id)),
    ).toEqual(sourceBefore);
    const receipts = await f.db.orm
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.runId, fork.run.id));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.result).toMatchObject({
      output: { simulation: true, matchedFixture: true },
    });
    expect(
      (await f.db.orm.select().from(costLedger).where(eq(costLedger.runId, fork.run.id))).length,
    ).toBe(2);
    expect((await forkRun(f.db, f.userId, mission.run.id, input, settings)).run.id).toBe(
      fork.run.id,
    );
    await expect(
      forkRun(f.db, f.userId, mission.run.id, { ...input, prompt: 'Changed' }, settings),
    ).rejects.toMatchObject({ code: 'MISSION_CONFLICT' });
    await collectNotifications(f.db);
    expect(
      await f.db.orm.select().from(notifications).where(eq(notifications.sourceRunId, fork.run.id)),
    ).toHaveLength(0);
  });

  it('forks at a tool boundary and retains exact approval and receipt recovery', async () => {
    const [prior] = await f.db.orm.select().from(runReplays);
    const original = await runDetail(f.db, f.userId, prior!.sourceRunId);
    const selected = original.steps.find((step) => step.toolName === 'files.write')!;
    const fork = await forkRun(
      f.db,
      f.userId,
      prior!.sourceRunId,
      { stepId: selected.id, requestId: randomUUID() },
      settings,
    );
    settings.security.value.preset = 'cautious';
    const callsBefore = live.mock.calls.length;
    const executor = makeExecutor();
    await executor.execute(fork.run.id);
    const waiting = await runDetail(f.db, f.userId, fork.run.id);
    expect(waiting.run.status).toBe('waiting_approval');
    const approval = waiting.approvals[0]!;
    await decideApproval(
      f.db,
      f.userId,
      approval.id,
      {
        version: approval.version,
        action: 'approve',
        note: '',
      },
      tools,
      () => settings,
    );
    const [resume] = await f.db.orm.select().from(runs).where(eq(runs.id, fork.run.id));
    await executor.execute(fork.run.id);
    expect((await runDetail(f.db, f.userId, fork.run.id)).run.status).toBe('completed');
    // Lose the checkpoint acknowledgement after a confirmed mock receipt, as a crash can do.
    await f.db.orm
      .update(runs)
      .set({ checkpoint: resume!.checkpoint, status: 'queued', workerId: null, claimKey: null })
      .where(eq(runs.id, fork.run.id));
    await executor.execute(fork.run.id);
    expect(
      (await f.db.orm.select().from(toolCalls).where(eq(toolCalls.runId, fork.run.id))).length,
    ).toBe(1);
    expect(live).toHaveBeenCalledTimes(callsBefore);
    settings.security.value.preset = 'balanced';
  });

  it('enforces ownership, strict API schemas and CSRF; reconstructs old prompts', async () => {
    const [prior] = await f.db.orm.select().from(runReplays);
    expect(prior).toBeTruthy();
    await expect(runDetail(f.db, 'another-owner', prior!.sourceRunId)).rejects.toMatchObject({
      code: 'MISSION_NOT_FOUND',
    });
    expect(
      (await f.request('GET', `/api/runs/${prior!.runId}/detail`, undefined, false)).statusCode,
    ).toBe(401);
    expect(
      runDetailSchema.parse((await f.request('GET', `/api/runs/${prior!.runId}/detail`)).json())
        .replay?.mocked,
    ).toBe(true);
    const input = { stepId: prior!.sourceStepId, requestId: randomUUID() };
    expect(
      (await f.request('POST', `/api/runs/${prior!.sourceRunId}/forks`, { ...input, live: true }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await f.request(
          'POST',
          `/api/runs/${prior!.sourceRunId}/forks`,
          input,
          true,
          'https://hostile.example',
        )
      ).statusCode,
    ).toBe(403);
    await f.db.orm
      .update(runSteps)
      .set({ replayState: null })
      .where(eq(runSteps.id, prior!.sourceStepId));
    const fork = await forkRun(f.db, f.userId, prior!.sourceRunId, input, settings);
    expect(fork.replay?.reconstructed).toBe(true);
  });

  it('preserves private source context and refuses a selected cloud model', async () => {
    const [prior] = await f.db.orm.select().from(runReplays);
    const [sourceRun] = await f.db.orm.select().from(runs).where(eq(runs.id, prior!.sourceRunId));
    const state = durableCheckpointSchema.parse(sourceRun!.checkpoint);
    state.loop.privateOnly = true;
    await f.db.orm
      .update(runs)
      .set({ checkpoint: jsonValue(state) })
      .where(eq(runs.id, sourceRun!.id));
    settings.providers.value.items.push({
      id: 'cloud',
      name: 'Cloud',
      kind: 'openai-compatible',
      baseUrl: 'https://model.example',
      secretRef: null,
      locality: 'cloud',
      enabled: true,
    });
    await expect(
      forkRun(
        f.db,
        f.userId,
        sourceRun!.id,
        {
          stepId: prior!.sourceStepId,
          requestId: randomUUID(),
          model: { providerId: 'cloud', modelId: 'remote' },
        },
        settings,
      ),
    ).rejects.toMatchObject({ code: 'MISSION_INVALID' });
    const fork = await forkRun(
      f.db,
      f.userId,
      sourceRun!.id,
      { stepId: prior!.sourceStepId, requestId: randomUUID() },
      settings,
    );
    await makeExecutor().execute(fork.run.id);
    expect(requests.at(-1)?.privateOnly).toBe(true);
  });
});
