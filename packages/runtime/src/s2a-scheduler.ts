import { createHash } from 'node:crypto';
import { and, eq, lte } from 'drizzle-orm';
import type { SettingsDocument } from '@sazuz/config/settings';
import {
  getControl,
  missions,
  projects,
  runS2a,
  s2aSchedules,
  s2aWorkflows,
  type Database,
} from '@sazuz/db';
import { nextCronOccurrences } from '@sazuz/triggers';

/** A committed mission can survive a rolled-back timer update; its stable request ID prevents a second run. */
export async function tickS2aSchedules(
  database: Database,
  getSettings: () => SettingsDocument,
  now = new Date(),
) {
  if ((await getControl(database)).paused) return;
  const due = await database.orm
    .select({ id: s2aSchedules.workflowId })
    .from(s2aSchedules)
    .where(and(eq(s2aSchedules.enabled, true), lte(s2aSchedules.nextRunAt, now)))
    .limit(10);
  for (const { id } of due)
    await database.orm.transaction(async (tx) => {
      const [schedule] = await tx
        .select()
        .from(s2aSchedules)
        .where(
          and(
            eq(s2aSchedules.workflowId, id),
            eq(s2aSchedules.enabled, true),
            lte(s2aSchedules.nextRunAt, now),
          ),
        )
        .for('update', { skipLocked: true });
      if (!schedule) return;
      const [row] = await tx
        .select({ workflow: s2aWorkflows, userId: projects.userId })
        .from(s2aWorkflows)
        .innerJoin(projects, eq(projects.id, s2aWorkflows.projectId))
        .where(eq(s2aWorkflows.id, id));
      if (!row?.workflow.publishedRevision) return;
      const key = createHash('sha256')
        .update(`${id}:${schedule.version}:${schedule.nextRunAt.toISOString()}`)
        .digest('hex');
      const requestId = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
      const [existing] = await tx
        .select({ id: missions.id })
        .from(missions)
        .where(
          and(eq(missions.projectId, row.workflow.projectId), eq(missions.requestId, requestId)),
        );
      const budget = getSettings().budgets.value;
      if (!existing)
        await runS2a(
          database,
          row.userId,
          id,
          { revision: row.workflow.publishedRevision, requestId, input: schedule.input },
          {
            maxSteps: budget.maxSteps,
            maxCostUsd: budget.perRunUsd,
            maxWallTimeSeconds: budget.maxWallTimeSeconds,
          },
        );
      await tx
        .update(s2aSchedules)
        .set({
          nextRunAt: new Date(
            nextCronOccurrences({
              expression: schedule.expression,
              timezone: schedule.timezone,
              now,
              count: 1,
            })[0]!,
          ),
        })
        .where(eq(s2aSchedules.workflowId, id));
    });
}
