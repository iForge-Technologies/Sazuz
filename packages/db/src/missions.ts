import { createHash } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { z } from 'zod';
import { missionReviews } from './reviews.js';
import { SazuzError } from '@sazuz/core';
import {
  missionInputSchema,
  missionLimitsSchema,
  recipePolicySchema,
  missionSchema,
  runSchema,
  stepSchema,
  approvalSchema,
  agentMessageSchema,
  controlSchema,
  type MissionInput,
  type RunControl,
} from '@sazuz/core/missions';
import { secretRedactor } from '@sazuz/vault';
import type { Database } from './client.js';
import { graphView, missionBlackboard, missionTotals, wakeParent } from './graphs.js';
import {
  missions,
  runs,
  projects,
  threads,
  messages,
  runSteps,
  approvals,
  agentMessages,
  queueOutbox,
  auditLog,
  executionControl,
  browserSessions,
} from './schema.js';

export type Transaction = Parameters<Parameters<Database['orm']['transaction']>[0]>[0];
/** Include every generation when controlling nested graph/workflow runs. */
export const descendantRunIds = (runId: string) => sql`WITH RECURSIVE descendants AS (
  SELECT id FROM runs WHERE parent_run_id = ${runId}
  UNION SELECT r.id FROM runs r JOIN descendants d ON r.parent_run_id = d.id
) SELECT id FROM descendants`;
export async function runHasStoppedAncestor(db: Database, runId: string) {
  const result = await db.pool.query<{ stopped: boolean }>(
    `WITH RECURSIVE ancestors AS (
    SELECT p.id, p.parent_run_id, p.status FROM runs r JOIN runs p ON p.id=r.parent_run_id WHERE r.id=$1
    UNION SELECT p.id, p.parent_run_id, p.status FROM runs p JOIN ancestors a ON p.id=a.parent_run_id
  ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE status IN ('paused','cancelled','failed','budget_exceeded')) AS stopped`,
    [runId],
  );
  return result.rows[0]?.stopped ?? true;
}
export class MissionError extends SazuzError {
  constructor(
    code:
      | 'MISSION_NOT_FOUND'
      | 'MISSION_CONFLICT'
      | 'MISSION_INVALID'
      | 'MISSION_BUSY'
      | 'APPROVAL_INVALID'
      | 'APPROVAL_EXPIRED'
      | 'EXECUTION_PAUSED'
      | 'BROWSER_CONTROL_REQUIRED',
  ) {
    super(
      code,
      {
        MISSION_NOT_FOUND: 'This mission or run is unavailable.',
        MISSION_CONFLICT: 'This item changed. Refresh before acting.',
        MISSION_INVALID: 'Check the mission or budget fields.',
        MISSION_BUSY: 'The run is still stopping. Wait a moment and resume.',
        APPROVAL_INVALID: 'This decision does not match the pending action.',
        APPROVAL_EXPIRED: 'This approval expired. Review the latest proposed action.',
        EXECUTION_PAUSED: 'All agents are paused. Resume them from the header first.',
        BROWSER_CONTROL_REQUIRED: 'Hand back browser control before resuming this mission.',
      }[code],
    );
  }
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const valueHash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export const workKey = (prefix: string) => `${prefix}_${ulid()}`;
export async function enqueueRun(tx: Transaction, runId: string) {
  await tx
    .insert(queueOutbox)
    .values({ runId })
    .onConflictDoUpdate({
      target: queueOutbox.runId,
      set: { generation: sql`${queueOutbox.generation}+1`, createdAt: new Date() },
    });
}
export async function insertMission(
  tx: Transaction,
  userId: string,
  input: MissionInput,
  limits: unknown,
  source = 'web',
  tainted = false,
  existingThreadId?: string,
  recipePolicy: z.infer<typeof recipePolicySchema> | null = null,
) {
  const body = missionInputSchema.parse(input);
  const caps = missionLimitsSchema.parse(limits);
  const [project] = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.id, body.projectId), eq(projects.userId, userId)));
  if (!project) throw new MissionError('MISSION_NOT_FOUND');
  if (existingThreadId) {
    const [thread] = await tx
      .select()
      .from(threads)
      .where(and(eq(threads.id, existingThreadId), eq(threads.projectId, body.projectId)))
      .for('update');
    if (!thread) throw new MissionError('MISSION_NOT_FOUND');
  }
  const [existing] = await tx
    .select()
    .from(missions)
    .where(and(eq(missions.projectId, body.projectId), eq(missions.requestId, body.requestId)));
  if (existing) {
    if (existingThreadId && existing.threadId !== existingThreadId)
      throw new MissionError('MISSION_CONFLICT');
    return existing.id;
  }
  if (existingThreadId) {
    const active = await tx
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(missions, eq(missions.id, runs.missionId))
      .where(
        and(
          eq(missions.threadId, existingThreadId),
          sql`${runs.status} NOT IN ('completed','failed','cancelled')`,
        ),
      )
      .limit(1);
    if (active.length) throw new MissionError('MISSION_BUSY');
    const prior = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.threadId, existingThreadId), eq(messages.requestId, body.requestId)))
      .limit(1);
    if (prior.length) throw new MissionError('MISSION_CONFLICT');
  }
  const missionId = workKey('mis'),
    threadId = existingThreadId ?? workKey('thr'),
    runId = workKey('run');
  const title = secretRedactor.redactText(body.title ?? body.goal.slice(0, 100));
  const goal = secretRedactor.redactText(body.goal);
  if (!existingThreadId)
    await tx.insert(threads).values({ id: threadId, projectId: body.projectId, title });
  await tx.insert(missions).values({
    id: missionId,
    projectId: body.projectId,
    threadId,
    title,
    goal,
    agent: body.agent,
    requestId: body.requestId,
    source,
    recipePolicy: recipePolicySchema.nullable().parse(recipePolicy),
  });
  await tx.insert(messages).values({
    id: workKey('msg'),
    threadId,
    role: 'user',
    content: goal,
    trust: tainted ? 'untrusted' : 'trusted',
    requestId: body.requestId,
  });
  await tx
    .insert(runs)
    .values({ id: runId, missionId, limits: caps, agentId: body.agent, tainted });
  await enqueueRun(tx, runId);
  return missionId;
}
export async function createMission(
  db: Database,
  userId: string,
  input: unknown,
  limits: unknown,
  source = 'web',
  tainted = false,
  existingThreadId?: string,
) {
  const parsed = missionInputSchema.safeParse(input);
  if (!parsed.success) throw new MissionError('MISSION_INVALID');
  // Serialize repeated request IDs before checking/inserting the mission and its outbox.
  const id = await db.orm.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${parsed.data.requestId}`},0))`,
    );
    return insertMission(tx, userId, parsed.data, limits, source, tainted, existingThreadId);
  });
  return (await getMission(db, userId, id))!.mission;
}
export const publicRun = (row: typeof runs.$inferSelect) =>
  runSchema.parse({
    id: row.id,
    missionId: row.missionId,
    agentId: row.agentId,
    status: row.status,
    step: row.step + row.reviewSteps,
    costUsd: row.costUsd,
    limits: row.limits,
    tainted: row.tainted,
    reason: row.reason,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
const publicMission = (mission: typeof missions.$inferSelect, run: typeof runs.$inferSelect) =>
  missionSchema.parse({
    id: mission.id,
    projectId: mission.projectId,
    threadId: mission.threadId,
    title: mission.title,
    goal: mission.goal,
    agent: mission.agent,
    recipePolicy: mission.recipePolicy,
    createdAt: mission.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    run: publicRun(run),
  });
export async function listMissions(db: Database, userId: string) {
  const rows = await db.orm
    .select({ mission: missions, run: runs })
    .from(missions)
    .innerJoin(runs, and(eq(runs.missionId, missions.id), sql`${runs.parentRunId} IS NULL`))
    .innerJoin(projects, eq(projects.id, missions.projectId))
    .where(eq(projects.userId, userId))
    .orderBy(desc(missions.createdAt))
    .limit(100);
  return Promise.all(
    rows.map(async ({ mission, run }) =>
      publicMission(mission, { ...run, ...(await missionTotals(db, mission.id)) }),
    ),
  );
}
export async function missionContext(db: Database, runId: string, userId?: string) {
  const [row] = await db.orm
    .select({ run: runs, mission: missions, project: projects })
    .from(runs)
    .innerJoin(missions, eq(missions.id, runs.missionId))
    .innerJoin(projects, eq(projects.id, missions.projectId))
    .where(and(eq(runs.id, runId), ...(userId ? [eq(projects.userId, userId)] : [])));
  return row;
}
export const publicApproval = (
  row: typeof approvals.$inferSelect,
  mission: typeof missions.$inferSelect,
) =>
  approvalSchema.parse({
    id: row.id,
    runId: row.runId,
    missionId: mission.id,
    projectId: mission.projectId,
    agentId: row.agentId,
    toolName: row.toolName,
    args: row.args,
    effect: row.effect,
    reason: row.reason,
    risk: row.risk,
    ruleId: row.ruleId,
    tainted: row.tainted,
    kind: row.kind,
    status: row.status,
    version: row.version,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    note: row.note,
  });
export async function listApprovals(db: Database, userId: string) {
  return (
    await db.orm
      .select({ approval: approvals, mission: missions })
      .from(approvals)
      .innerJoin(runs, eq(runs.id, approvals.runId))
      .innerJoin(missions, eq(missions.id, runs.missionId))
      .innerJoin(projects, eq(projects.id, missions.projectId))
      .where(eq(projects.userId, userId))
      .orderBy(desc(approvals.createdAt))
      .limit(200)
  ).map(({ approval, mission }) => publicApproval(approval, mission));
}
export async function getMission(db: Database, userId: string, id: string) {
  const [row] = await db.orm
    .select({ mission: missions, run: runs })
    .from(missions)
    .innerJoin(runs, and(eq(runs.missionId, missions.id), sql`${runs.parentRunId} IS NULL`))
    .innerJoin(projects, eq(projects.id, missions.projectId))
    .where(and(eq(missions.id, id), eq(projects.userId, userId)));
  if (!row) return null;
  const steps = await db.orm
    .select({ step: runSteps })
    .from(runSteps)
    .innerJoin(runs, eq(runs.id, runSteps.runId))
    .where(eq(runs.missionId, id))
    .orderBy(asc(runSteps.createdAt), asc(runSteps.ordinal), asc(runSteps.id));
  const pending = await db.orm
    .select({ approval: approvals })
    .from(approvals)
    .innerJoin(runs, eq(runs.id, approvals.runId))
    .where(eq(runs.missionId, id))
    .orderBy(asc(approvals.createdAt));
  const handoffs = await db.orm
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.missionId, id))
    .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id));
  return {
    mission: publicMission(row.mission, { ...row.run, ...(await missionTotals(db, id)) }),
    graph: await graphView(db, userId, id),
    blackboard: await missionBlackboard(db, userId, id),
    reviews: await missionReviews(db, id),
    steps: steps.map(({ step: { eventKey: _eventKey, replayState: _replayState, ...step } }) =>
      stepSchema.parse({ ...step, createdAt: step.createdAt.toISOString() }),
    ),
    approvals: pending.map(({ approval }) => publicApproval(approval, row.mission)),
    agentMessages: handoffs.map((item) =>
      agentMessageSchema.parse({
        id: item.id,
        from: item.from,
        to: item.to,
        type: item.type,
        content: item.content,
        taskId: item.taskId,
        payload: item.payload,
        createdAt: item.createdAt.toISOString(),
      }),
    ),
  };
}
export async function getControl(db: Database) {
  await db.orm.insert(executionControl).values({}).onConflictDoNothing();
  const [row] = await db.orm.select().from(executionControl);
  return controlSchema.parse({
    paused: row!.paused,
    version: row!.version,
    updatedAt: row!.updatedAt.toISOString(),
  });
}
export async function setControl(db: Database, userId: string, paused: boolean, version: number) {
  await getControl(db);
  await db.orm.transaction(async (tx) => {
    const changed = await tx
      .update(executionControl)
      .set({ paused, version: version + 1, updatedAt: new Date() })
      .where(eq(executionControl.version, version))
      .returning();
    if (!changed.length) throw new MissionError('MISSION_CONFLICT');
    if (paused)
      await tx
        .update(runs)
        .set({
          status: 'paused',
          reason: 'Paused by the global kill switch.',
          version: sql`${runs.version}+1`,
          updatedAt: new Date(),
        })
        .where(sql`${runs.status} IN ('queued','running','waiting_tasks')`);
    else {
      const resume = await tx
        .update(runs)
        .set({
          status: 'queued',
          reason: null,
          version: sql`${runs.version}+1`,
          updatedAt: new Date(),
        })
        .where(and(eq(runs.status, 'paused'), eq(runs.reason, 'Paused by the global kill switch.')))
        .returning({ id: runs.id });
      for (const row of resume) await enqueueRun(tx, row.id);
    }
    await tx.insert(auditLog).values({
      id: workKey('aud'),
      actorId: userId,
      action: paused ? 'execution.pause_all' : 'execution.unpause',
      target: 'all',
    });
    await tx.execute(sql`SELECT pg_notify('execution_changed','control')`);
  });
  return getControl(db);
}
export async function controlRun(db: Database, userId: string, runId: string, command: RunControl) {
  if (!(await missionContext(db, runId, userId))) throw new MissionError('MISSION_NOT_FOUND');
  if ((command.action === 'resume' || command.action === 'extend') && (await getControl(db)).paused)
    throw new MissionError('EXECUTION_PAUSED');
  await db.orm.transaction(async (tx) => {
    const [row] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update');
    if (!row || row.version !== command.version) throw new MissionError('MISSION_CONFLICT');
    if (['completed', 'cancelled'].includes(row.status)) throw new MissionError('MISSION_INVALID');
    if ((command.action === 'resume' || command.action === 'extend') && row.claimKey)
      throw new MissionError('MISSION_BUSY');
    if (
      (command.action === 'resume' || command.action === 'extend') &&
      row.status === 'waiting_approval'
    )
      throw new MissionError('APPROVAL_INVALID');
    const limits = missionLimitsSchema.parse(row.limits);
    const humanBrowser = await hasHumanBrowser(db, runId);
    if (command.action === 'resume' && humanBrowser)
      throw new MissionError('BROWSER_CONTROL_REQUIRED');
    if (command.action === 'extend') {
      limits.maxCostUsd += command.addCostUsd;
      limits.maxSteps += command.addSteps;
      limits.maxWallTimeSeconds += command.addWallTimeSeconds;
      if (
        !missionLimitsSchema.safeParse(limits).success ||
        command.addCostUsd + command.addSteps + command.addWallTimeSeconds === 0
      )
        throw new MissionError('MISSION_INVALID');
    } else if (command.addCostUsd + command.addSteps + command.addWallTimeSeconds !== 0)
      throw new MissionError('MISSION_INVALID');
    const status =
      command.action === 'cancel'
        ? 'cancelled'
        : command.action === 'pause' || humanBrowser
          ? 'paused'
          : 'queued';
    await tx
      .update(runs)
      .set({
        limits,
        status,
        reason: status === 'paused' ? 'Paused by the operator.' : null,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId));
    if (status === 'queued') await enqueueRun(tx, runId);
    {
      if (status === 'paused' || status === 'cancelled') {
        await tx
          .update(runs)
          .set({
            status,
            reason: 'Stopped with the parent mission.',
            version: sql`${runs.version}+1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              sql`${runs.id} IN (${descendantRunIds(runId)})`,
              sql`${runs.status} NOT IN ('completed','cancelled','failed')`,
            ),
          );
      } else {
        const children = await tx
          .update(runs)
          .set({
            status: 'queued',
            reason: null,
            version: sql`${runs.version}+1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              sql`${runs.id} IN (${descendantRunIds(runId)})`,
              eq(runs.status, 'paused'),
              eq(runs.reason, 'Stopped with the parent mission.'),
            ),
          )
          .returning({ id: runs.id });
        for (const child of children) await enqueueRun(tx, child.id);
      }
    }
    if (row.parentRunId) await wakeParent(tx, row.parentRunId);
    await tx.insert(auditLog).values({
      id: workKey('aud'),
      actorId: userId,
      action: `run.${command.action}`,
      target: runId,
    });
    await tx.execute(sql`SELECT pg_notify('execution_changed',${runId})`);
  });
  const current = (await missionContext(db, runId, userId))!.run;
  return publicRun(
    current.parentRunId ? current : { ...current, ...(await missionTotals(db, current.missionId)) },
  );
}
export const jsonValue = (value: unknown) => z.json().parse(secretRedactor.redact(value));

export async function hasHumanBrowser(db: Database, runId: string) {
  const rows = await db.orm
    .select({ id: browserSessions.id })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.runId, runId),
        eq(browserSessions.status, 'active'),
        eq(browserSessions.control, 'human'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
