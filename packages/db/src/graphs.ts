import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { graphViewSchema, blackboardEntrySchema } from '@sazuz/core/graphs';
import { missionLimitsSchema } from '@sazuz/core/missions';
import type { Database } from './client.js';
import {
  missionGraphs,
  graphRevisions,
  missionTasks,
  runs,
  blackboardEntries,
  projects,
  missions,
} from './schema.js';
import { enqueueRun, type Transaction } from './missions.js';

export async function missionTotals(db: Database, missionId: string) {
  const { rows } = await db.pool.query<{
    step: number;
    reviewSteps: number;
    costUsd: number;
    tainted: boolean;
  }>(
    'SELECT coalesce(sum(step),0)::int AS step, coalesce(sum(review_steps),0)::int AS "reviewSteps", coalesce(sum(cost_usd),0)::float8 AS "costUsd", coalesce(bool_or(tainted),false) AS tainted FROM runs WHERE mission_id=$1',
    [missionId],
  );
  return rows[0]!;
}
export async function missionAllowance(db: Database, missionId: string) {
  const [root] = await db.orm
    .select()
    .from(runs)
    .where(and(eq(runs.missionId, missionId), sql`${runs.parentRunId} IS NULL`));
  if (!root) throw new Error('Mission root is unavailable.');
  const limits = missionLimitsSchema.parse(root.limits),
    totals = await missionTotals(db, missionId);
  return {
    steps: limits.maxSteps - totals.step - totals.reviewSteps,
    usd: limits.maxCostUsd - totals.costUsd,
    root,
  };
}
export async function wakeParent(tx: Transaction, parentRunId: string | null) {
  if (!parentRunId) return;
  const changed = await tx
    .update(runs)
    .set({ status: 'queued', updatedAt: new Date() })
    .where(and(eq(runs.id, parentRunId), eq(runs.status, 'waiting_tasks')))
    .returning({ id: runs.id });
  if (changed.length) await enqueueRun(tx, parentRunId);
}
export async function graphView(db: Database, userId: string, missionId: string) {
  const [graph] = await db.orm
    .select({ graph: missionGraphs })
    .from(missionGraphs)
    .innerJoin(missions, eq(missions.id, missionGraphs.missionId))
    .innerJoin(projects, eq(projects.id, missions.projectId))
    .where(and(eq(missionGraphs.missionId, missionId), eq(projects.userId, userId)));
  if (!graph) return null;
  const [tasks, revisions] = await Promise.all([
    db.orm
      .select()
      .from(missionTasks)
      .where(eq(missionTasks.missionId, missionId))
      .orderBy(asc(missionTasks.taskKey)),
    db.orm
      .select()
      .from(graphRevisions)
      .where(eq(graphRevisions.missionId, missionId))
      .orderBy(asc(graphRevisions.revision)),
  ]);
  const usage = await db.pool.query<{ task_id: string; steps: number; cost: number }>(
    'SELECT a.task_id,sum(r.step+r.review_steps)::int AS steps,sum(r.cost_usd)::float8 AS cost FROM task_attempts a JOIN runs r ON r.id=a.run_id WHERE r.mission_id=$1 GROUP BY a.task_id',
    [missionId],
  );
  return graphViewSchema.parse({
    revision: graph.graph.revision,
    plan: graph.graph.definition,
    revisions: revisions.map((row) => ({
      revision: row.revision,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    })),
    tasks: tasks.map((row) => ({
      id: row.id,
      key: row.taskKey,
      definition: row.definition,
      status: row.status,
      attempt: row.attempt,
      runId: row.runId,
      feedback: row.feedback,
      result: row.result,
      steps: usage.rows.find((item) => item.task_id === row.id)?.steps ?? 0,
      costUsd: usage.rows.find((item) => item.task_id === row.id)?.cost ?? 0,
    })),
  });
}
export async function missionBlackboard(db: Database, userId: string, missionId: string) {
  const notes = await db.orm
    .select({ note: blackboardEntries })
    .from(blackboardEntries)
    .innerJoin(missions, eq(missions.id, blackboardEntries.missionId))
    .innerJoin(projects, eq(projects.id, missions.projectId))
    .where(and(eq(blackboardEntries.missionId, missionId), eq(projects.userId, userId)))
    .orderBy(desc(blackboardEntries.createdAt), desc(blackboardEntries.id))
    .limit(200);
  return notes.reverse().map(({ note }) =>
    blackboardEntrySchema.parse({
      id: note.id,
      runId: note.runId,
      agentId: note.agentId,
      text: note.text,
      artifacts: note.artifacts,
      tainted: note.tainted,
      privateOnly: note.privateOnly,
      createdAt: note.createdAt.toISOString(),
    }),
  );
}
