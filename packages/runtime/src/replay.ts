import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { forkInputSchema, replaySchema, runDetailSchema } from '@sazuz/core/replay';
import { agentRoleSchema, missionLimitsSchema, stepSchema } from '@sazuz/core/missions';
import {
  auditLog,
  insertMission,
  jsonValue,
  missionContext,
  MissionError,
  publicApproval,
  publicRun,
  runSteps,
  runReplays,
  runs,
  approvals,
  runAgentVersions,
  runMcpSelections,
  runBridgeSelections,
  valueHash,
  workKey,
  type Database,
} from '@sazuz/db';
import type { SettingsDocument } from '@sazuz/config/settings';
import { llmMessageSchema, llmToolCallSchema, type LlmMessage } from '@sazuz/llm/contracts';
import { mockFixturesSchema, renderToolOutput } from '@sazuz/tools';
import { skillVersion } from '@sazuz/skills';
import { secretRedactor } from '@sazuz/vault';
import { checkpointSchema, type RunCheckpoint } from './contracts.js';
import { durableCheckpointSchema } from './durable-contracts.js';
import { newCheckpoint, SYSTEM_RULES } from './loop.js';
import { inheritedRecipePolicyValue } from './recipe-policy.js';

type Step = typeof runSteps.$inferSelect;
const publicReplay = (row: typeof runReplays.$inferSelect) =>
  replaySchema.parse({
    runId: row.runId,
    sourceRunId: row.sourceRunId,
    sourceStepId: row.sourceStepId,
    sourceOrdinal: row.sourceOrdinal,
    model: row.model,
    skill: row.skill,
    privateOnly: row.privateOnly,
    reconstructed: row.reconstructed,
    mocked: true,
    createdAt: row.createdAt.toISOString(),
  });

/** Captures the next operation, excluding the observation being recorded by onTool. */
export function replaySnapshot(loop: RunCheckpoint, prompt?: LlmMessage[]): RunCheckpoint {
  const copy = checkpointSchema.parse(secretRedactor.redact(structuredClone(loop)));
  if (prompt) {
    copy.messages = z.array(llmMessageSchema).parse(secretRedactor.redact(prompt));
    copy.pendingCalls = [];
    copy.nextCall = 0;
    copy.step = Math.max(0, copy.step - 1);
  } else {
    const last = copy.messages.at(-1);
    if (last?.role === 'tool' && last.toolCallId === copy.pendingCalls[copy.nextCall]?.id)
      copy.messages.pop();
  }
  copy.status = 'running';
  copy.reason = null;
  return copy;
}

export function replaySeed(steps: Step[], selected: Step, goal: string) {
  if (selected.replayState)
    return { loop: checkpointSchema.parse(selected.replayState), reconstructed: false };
  const before = steps.filter((step) => step.ordinal <= selected.ordinal);
  const origin = [...before].reverse().find((step) => !!step.prompt);
  const prompt = origin?.prompt
    ? z.array(llmMessageSchema).parse(JSON.parse(origin.prompt))
    : [
        { role: 'system' as const, content: SYSTEM_RULES },
        { role: 'user' as const, content: goal },
      ];
  const loop = newCheckpoint(prompt, true);
  if (origin && origin.id !== selected.id) {
    const calls = z.array(llmToolCallSchema).safeParse(origin.toolResult);
    if (calls.success && calls.data.length) {
      loop.messages.push({ role: 'assistant', content: origin.content, toolCalls: calls.data });
      loop.pendingCalls = calls.data;
      for (const call of calls.data) {
        const receipt = before.find(
          (step) =>
            step.ordinal > origin.ordinal &&
            step.ordinal < selected.ordinal &&
            step.kind === 'tool' &&
            step.toolName === call.name &&
            valueHash(step.toolArgs) === valueHash(call.args) &&
            z.object({ status: z.enum(['done', 'error', 'denied']) }).safeParse(step.toolResult)
              .success,
        );
        if (!receipt) break;
        loop.messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: receipt.content,
        });
        loop.nextCall++;
      }
    } else
      loop.messages.push({
        role: 'user',
        content: renderToolOutput({
          output: {
            sourceStep: selected.kind,
            evidence: before
              .map((step) => ({ kind: step.kind, content: step.content.slice(0, 4000) }))
              .slice(-12),
          },
          untrusted: true,
        }),
      });
  } else if (!origin)
    loop.messages.push({
      role: 'user',
      content: renderToolOutput({
        output: {
          selectedStep: selected.content.slice(0, 8000),
          tool: selected.toolName,
          args: selected.toolArgs,
        },
        untrusted: true,
      }),
    });
  return { loop, reconstructed: true };
}

export async function runDetail(db: Database, userId: string, runId: string) {
  const context = await missionContext(db, runId, userId);
  if (!context) throw new MissionError('MISSION_NOT_FOUND');
  const steps = await db.orm
    .select()
    .from(runSteps)
    .where(eq(runSteps.runId, runId))
    .orderBy(asc(runSteps.ordinal), asc(runSteps.id));
  const [replay] = await db.orm.select().from(runReplays).where(eq(runReplays.runId, runId));
  const forks = await db.orm
    .select()
    .from(runReplays)
    .where(and(eq(runReplays.sourceRunId, runId), eq(runReplays.userId, userId)))
    .orderBy(desc(runReplays.createdAt))
    .limit(100);
  const pending = await db.orm.select().from(approvals).where(eq(approvals.runId, runId));
  const source = replay ? await missionContext(db, replay.sourceRunId, userId) : null;
  return runDetailSchema.parse(
    secretRedactor.redact({
      run: publicRun(context.run),
      title: context.mission.title,
      projectId: context.project.id,
      steps: steps.map(({ eventKey: _key, replayState: _snapshot, ...step }) =>
        stepSchema.parse({ ...step, createdAt: step.createdAt.toISOString() }),
      ),
      approvals: pending.map((item) => publicApproval(item, context.mission)),
      replay: replay ? publicReplay(replay) : null,
      forks: forks.map(publicReplay),
      source: source ? publicRun(source.run) : null,
    }),
  );
}

export async function forkRun(
  db: Database,
  userId: string,
  runId: string,
  input: unknown,
  settings: SettingsDocument,
) {
  const body = forkInputSchema.parse(input);
  if (JSON.stringify(body) !== JSON.stringify(secretRedactor.redact(body)))
    throw new MissionError('MISSION_INVALID');
  const context = await missionContext(db, runId, userId);
  if (!context) throw new MissionError('MISSION_NOT_FOUND');
  const requestHash = valueHash({ runId, ...body });
  const existing = await db.orm
    .select()
    .from(runReplays)
    .where(and(eq(runReplays.userId, userId), eq(runReplays.requestId, body.requestId)));
  if (existing[0]) {
    if (existing[0].requestHash !== requestHash) throw new MissionError('MISSION_CONFLICT');
    return runDetail(db, userId, existing[0].runId);
  }
  const steps = await db.orm
    .select()
    .from(runSteps)
    .where(eq(runSteps.runId, runId))
    .orderBy(asc(runSteps.ordinal), asc(runSteps.id));
  const selected = steps.find((step) => step.id === body.stepId);
  if (!selected) throw new MissionError('MISSION_NOT_FOUND');
  const seed = replaySeed(steps, selected, context.mission.goal);
  const old = durableCheckpointSchema.safeParse(context.run.checkpoint);
  const skill = body.skill
    ? await skillVersion(db, userId, body.skill.id, body.skill.revision)
    : null;
  if (skill && !skill.enabled) throw new MissionError('MISSION_INVALID');
  const privateOnly =
    seed.loop.privateOnly ||
    context.project.privacy === 'private' ||
    (old.success ? old.data.loop.privateOnly : true) ||
    !!skill?.privateOnly;
  if (body.model) {
    const provider = settings.providers.value.items.find(
      (item) => item.id === body.model!.providerId && item.enabled,
    );
    if (
      !provider ||
      ((privateOnly || settings.models.value.preset === 'private') && provider.locality !== 'local')
    )
      throw new MissionError('MISSION_INVALID');
  }
  const notes = [
    {
      role: 'system' as const,
      content:
        'This is an isolated replay. Every tool response is simulated. Never claim a real action occurred. Continue the selected agent step without launching the original mission graph.',
    },
    ...(body.prompt ? [{ role: 'user' as const, content: body.prompt }] : []),
    ...(skill
      ? [
          {
            role: 'user' as const,
            content: renderToolOutput({
              output: { selectedSkill: skill.markdown },
              untrusted: true,
            }),
          },
        ]
      : []),
  ];
  // Keep incomplete assistant/tool groups adjacent when forking immediately before a tool.
  let insert = seed.loop.messages.length;
  if (seed.loop.pendingCalls.length) {
    for (let index = seed.loop.messages.length - 1; index >= 0; index--)
      if (seed.loop.messages[index]?.role === 'assistant') {
        insert = index;
        break;
      }
  }
  seed.loop.messages.splice(insert, 0, ...notes);
  Object.assign(seed.loop, {
    step: 0,
    costUsd: 0,
    startedAt: new Date().toISOString(),
    seen: {},
    status: 'running',
    reason: null,
    failures: 0,
    tainted: true,
    privateOnly,
  });
  const fixtures = mockFixturesSchema.parse(
    steps
      .filter((step) => step.kind === 'tool')
      .flatMap((step) => {
        const result = z
          .object({
            status: z.literal('done'),
            output: z.json(),
            privateOnly: z.boolean().optional(),
          })
          .safeParse(step.toolResult);
        return result.success && step.toolName
          ? [
              {
                name: step.toolName,
                args: step.toolArgs,
                output: result.data.output,
                privateOnly: privateOnly || !!result.data.privateOnly,
              },
            ]
          : [];
      }),
  );
  const limits = missionLimitsSchema.parse({
    maxSteps: settings.budgets.value.maxSteps,
    maxCostUsd: settings.budgets.value.perRunUsd,
    maxWallTimeSeconds: settings.budgets.value.maxWallTimeSeconds,
  });
  const role = agentRoleSchema.parse(selected.agentId);
  const recipePolicy = await inheritedRecipePolicyValue(db, runId, context.mission.recipePolicy);
  const forkId = await db.orm.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`replay:${userId}:${body.requestId}`},0))`,
    );
    const [prior] = await tx
      .select()
      .from(runReplays)
      .where(and(eq(runReplays.userId, userId), eq(runReplays.requestId, body.requestId)));
    if (prior) {
      if (prior.requestHash !== requestHash) throw new MissionError('MISSION_CONFLICT');
      return prior.runId;
    }
    const missionId = await insertMission(
      tx,
      userId,
      {
        projectId: context.project.id,
        goal: context.mission.goal,
        agent: role,
        title: `Replay: ${context.mission.title}`.slice(0, 160),
        requestId: randomUUID(),
      },
      limits,
      'run-replay',
      true,
      undefined,
      recipePolicy,
    );
    const [run] = await tx.select().from(runs).where(eq(runs.missionId, missionId));
    if (!run || run.checkpoint !== null || run.status !== 'queued')
      throw new MissionError('MISSION_CONFLICT');
    await tx
      .update(runs)
      .set({
        checkpoint: jsonValue(
          durableCheckpointSchema.parse({
            version: 1,
            loop: seed.loop,
            phase: 'direct',
            agentId: role,
            plan: null,
            taskIndex: 0,
            results: [],
          }),
        ),
      })
      .where(eq(runs.id, run.id));
    const pins = await tx
      .select()
      .from(runAgentVersions)
      .where(and(eq(runAgentVersions.runId, runId), eq(runAgentVersions.role, role)));
    for (const pin of pins) await tx.insert(runAgentVersions).values({ ...pin, runId: run.id });
    for (const table of [runMcpSelections, runBridgeSelections]) {
      const [pin] = await tx.select().from(table).where(eq(table.runId, runId));
      await tx.insert(table).values({ runId: run.id, revisionIds: pin?.revisionIds ?? [] });
    }
    await tx.insert(runReplays).values({
      runId: run.id,
      userId,
      sourceRunId: runId,
      sourceStepId: selected.id,
      sourceOrdinal: selected.ordinal,
      requestId: body.requestId,
      requestHash,
      model: body.model,
      skill: body.skill,
      fixtures: jsonValue(fixtures),
      privateOnly,
      reconstructed: seed.reconstructed,
    });
    await tx
      .insert(auditLog)
      .values({ id: workKey('aud'), actorId: userId, action: 'run.forked', target: run.id });
    return run.id;
  });
  return runDetail(db, userId, forkId);
}
