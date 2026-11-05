import { and, desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  browserRecordings,
  browserProfiles,
  browserSessions,
  projects,
  runs,
  auditLog,
  getControl,
  valueHash,
  workKey,
  type Database,
} from '@sazuz/db';
import {
  recordingControlSchema,
  recordingEventsSchema,
  recordingSchema,
  LearningError,
} from '@sazuz/core/learning';
import { secretRedactor } from '@sazuz/vault';

export function publicRecording(row: typeof browserRecordings.$inferSelect) {
  return recordingSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    projectId: row.projectId,
    name: secretRedactor.redactText(row.name),
    site: row.site,
    status: row.status,
    version: row.version,
    privateOnly: row.privateOnly,
    events: secretRedactor.redact(row.events),
    omitted: row.omitted,
    createdAt: row.createdAt.toISOString(),
  });
}
export async function recording(db: Database, userId: string, id: string) {
  const [row] = await db.orm
    .select()
    .from(browserRecordings)
    .where(and(eq(browserRecordings.id, id), eq(browserRecordings.userId, userId)));
  if (!row) throw new LearningError('LEARNING_NOT_FOUND');
  return publicRecording(row);
}
export async function listRecordings(db: Database, userId: string) {
  return (
    await db.orm
      .select()
      .from(browserRecordings)
      .where(eq(browserRecordings.userId, userId))
      .orderBy(desc(browserRecordings.createdAt))
      .limit(50)
  ).map(publicRecording);
}
export async function startRecording(
  db: Database,
  userId: string,
  sessionId: string,
  input: z.infer<typeof recordingControlSchema> & { action: 'start' },
) {
  const request = recordingControlSchema.parse(input);
  if (request.action !== 'start') throw new LearningError('LEARNING_INVALID');
  if (secretRedactor.redactText(request.name) !== request.name)
    throw new LearningError('LEARNING_INVALID');
  const hash = valueHash({ sessionId, name: request.name, privateOnly: request.privateOnly });
  const saved = await db.orm.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.id, sessionId))
      .for('update');
    const [profile] = session
      ? await tx
          .select()
          .from(browserProfiles)
          .where(and(eq(browserProfiles.id, session.profileId), eq(browserProfiles.userId, userId)))
      : [];
    if (!session || !profile) throw new LearningError('LEARNING_NOT_FOUND');
    const [prior] = await tx
      .select()
      .from(browserRecordings)
      .where(
        and(
          eq(browserRecordings.userId, userId),
          eq(browserRecordings.requestId, request.requestId),
        ),
      );
    if (prior) {
      if (prior.inputHash !== hash) throw new LearningError('LEARNING_CONFLICT');
      return prior;
    }
    const [run] = await tx.select().from(runs).where(eq(runs.id, session.runId));
    const [project] = await tx.select().from(projects).where(eq(projects.id, session.projectId));
    if (
      !run ||
      !project ||
      session.version !== request.version ||
      session.status !== 'active' ||
      session.control !== 'human' ||
      session.expiresAt.getTime() <= Date.now() ||
      profile.retired ||
      profile.generation !== session.profileGeneration ||
      run.claimKey ||
      !['paused', 'waiting_approval', 'budget_exceeded'].includes(run.status) ||
      (await getControl(db)).paused
    )
      throw new LearningError('LEARNING_DENIED');
    const active = await tx
      .select({ id: browserRecordings.id })
      .from(browserRecordings)
      .where(
        and(eq(browserRecordings.sessionId, sessionId), eq(browserRecordings.status, 'recording')),
      );
    if (active.length) throw new LearningError('LEARNING_CONFLICT');
    const [row] = await tx
      .insert(browserRecordings)
      .values({
        id: workKey('rec'),
        userId,
        projectId: session.projectId,
        sessionId,
        requestId: request.requestId,
        inputHash: hash,
        name: request.name,
        site: profile.site,
        privateOnly: request.privateOnly || project.privacy === 'private',
      })
      .returning();
    await tx.insert(auditLog).values({
      id: workKey('aud'),
      actorId: userId,
      action: 'browser.recording.started',
      target: row!.id,
    });
    return row!;
  });
  return publicRecording(saved);
}
/** Event writes and stop use the same row lock; no event may arrive after stop. */
export async function stopRecording(
  db: Database,
  userId: string,
  id: string,
  expectedVersion: number,
) {
  const row = await db.orm.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(browserRecordings)
      .where(and(eq(browserRecordings.id, id), eq(browserRecordings.userId, userId)))
      .for('update');
    if (!current) throw new LearningError('LEARNING_NOT_FOUND');
    if (current.status === 'stopped') return current;
    if (current.status !== 'recording') throw new LearningError('LEARNING_CONFLICT');
    // Input increments this version; a stop may include newer captured events, never omit them.
    if (current.version < expectedVersion) throw new LearningError('LEARNING_CONFLICT');
    recordingEventsSchema.parse(current.events);
    const [saved] = await tx
      .update(browserRecordings)
      .set({ status: 'stopped', version: current.version + 1, updatedAt: new Date() })
      .where(eq(browserRecordings.id, id))
      .returning();
    await tx.insert(auditLog).values({
      id: workKey('aud'),
      actorId: userId,
      action: 'browser.recording.stopped',
      target: id,
    });
    return saved!;
  });
  return publicRecording(row);
}
export async function interruptRecordings(db: Database, sessionId: string) {
  await db.orm
    .update(browserRecordings)
    .set({
      status: 'interrupted',
      version: sql`${browserRecordings.version}+1`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(browserRecordings.sessionId, sessionId), eq(browserRecordings.status, 'recording')),
    );
}
