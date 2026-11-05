import { and, asc, eq, sql } from 'drizzle-orm';
import {
  projectReviewSchema,
  projectReviewUpdateSchema,
  reviewRecordSchema,
} from '@sazuz/core/reviews';
import type { Database } from './client.js';
import { auditLog, auditReviews, projects, runs, settingsHistory } from './schema.js';
import { MissionError, workKey, jsonValue } from './missions.js';

export async function projectReview(db: Database, userId: string, projectId: string) {
  const [row] = await db.orm
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  if (!row) throw new MissionError('MISSION_NOT_FOUND');
  return projectReviewSchema.parse({ projectId, mode: row.reviewMode, version: row.reviewVersion });
}
export async function saveProjectReview(
  db: Database,
  userId: string,
  projectId: string,
  input: unknown,
) {
  const value = projectReviewUpdateSchema.parse(input);
  await db.orm.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .for('update');
    if (!row) throw new MissionError('MISSION_NOT_FOUND');
    if (row.reviewVersion !== value.expectedVersion) throw new MissionError('MISSION_CONFLICT');
    const namespace = `project:${projectId}:review`;
    await tx
      .insert(settingsHistory)
      .values({
        namespace,
        version: row.reviewVersion,
        value: { mode: row.reviewMode },
        actorId: userId,
      })
      .onConflictDoNothing();
    await tx
      .update(projects)
      .set({ reviewMode: value.mode, reviewVersion: row.reviewVersion + 1 })
      .where(eq(projects.id, projectId));
    await tx.insert(settingsHistory).values({
      namespace,
      version: row.reviewVersion + 1,
      value: { mode: value.mode },
      actorId: userId,
    });
    await tx.insert(auditLog).values({
      id: workKey('aud'),
      actorId: userId,
      action: 'project.review.changed',
      target: projectId,
    });
    await tx.execute(sql`SELECT pg_notify('settings_changed',${namespace})`);
    await tx.execute(sql`SELECT pg_notify('execution_changed',${projectId})`);
  });
  return projectReview(db, userId, projectId);
}
export const publicReview = (row: typeof auditReviews.$inferSelect) =>
  reviewRecordSchema.parse({
    id: row.id,
    runId: row.runId,
    sourceKey: row.sourceKey,
    kind: row.kind,
    subjectHash: row.subjectHash,
    status: row.status,
    verdict: row.verdict,
    evidence: row.evidence,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  });
export async function missionReviews(db: Database, missionId: string) {
  const rows = await db.orm
    .select({ review: auditReviews })
    .from(auditReviews)
    .innerJoin(runs, eq(runs.id, auditReviews.runId))
    .where(eq(runs.missionId, missionId))
    .orderBy(asc(auditReviews.createdAt), asc(auditReviews.id));
  return rows.map(({ review }) =>
    publicReview({ ...review, evidence: jsonValue(review.evidence) }),
  );
}
