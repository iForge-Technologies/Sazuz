import { and, desc, eq, sql } from 'drizzle-orm';
import {
  s2aInputSchema,
  s2aRecordSchema,
  s2aRunInputSchema,
  s2aStateSchema,
  s2aUpdateSchema,
} from '@sazuz/core/s2a';
import type { Database } from './client.js';
import {
  auditLog,
  missions,
  projects,
  runs,
  s2aExecutions,
  s2aRevisions,
  s2aWorkflows,
} from './schema.js';
import {
  getMission,
  insertMission,
  jsonValue,
  MissionError,
  valueHash,
  workKey,
} from './missions.js';

function publicWorkflow(row: typeof s2aWorkflows.$inferSelect) {
  return s2aRecordSchema.parse({ ...row, updatedAt: row.updatedAt.toISOString() });
}
export async function listS2a(database: Database, userId: string) {
  return (
    await database.orm
      .select({ workflow: s2aWorkflows })
      .from(s2aWorkflows)
      .innerJoin(projects, eq(s2aWorkflows.projectId, projects.id))
      .where(eq(projects.userId, userId))
      .orderBy(desc(s2aWorkflows.updatedAt))
  ).map((row) => publicWorkflow(row.workflow));
}
export async function saveS2a(database: Database, userId: string, input: unknown, id?: string) {
  return database.orm.transaction(async (tx) => {
    const existing = id
      ? (
          await tx
            .select({ workflow: s2aWorkflows })
            .from(s2aWorkflows)
            .innerJoin(projects, eq(projects.id, s2aWorkflows.projectId))
            .where(and(eq(s2aWorkflows.id, id), eq(projects.userId, userId)))
            .for('update', { of: s2aWorkflows })
        )[0]?.workflow
      : undefined;
    if (id && !existing) throw new MissionError('MISSION_NOT_FOUND');
    const update = existing ? s2aUpdateSchema.parse(input) : null;
    const body = update
      ? { ...update, projectId: existing!.projectId }
      : s2aInputSchema.parse(input);
    if (update && update.expectedRevision !== existing!.revision)
      throw new MissionError('MISSION_CONFLICT');
    const [project] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, body.projectId), eq(projects.userId, userId)));
    if (!project) throw new MissionError('MISSION_NOT_FOUND');
    const workflowId = id ?? workKey('wf');
    const revision = (existing?.revision ?? 0) + 1;
    const values = {
      name: body.name,
      description: body.description,
      graph: jsonValue(body.graph),
      revision,
      updatedAt: new Date(),
    };
    const [row] = existing
      ? await tx.update(s2aWorkflows).set(values).where(eq(s2aWorkflows.id, workflowId)).returning()
      : await tx
          .insert(s2aWorkflows)
          .values({ id: workflowId, projectId: body.projectId, ...values })
          .returning();
    await tx.insert(s2aRevisions).values({ workflowId, revision, graph: jsonValue(body.graph) });
    await tx.insert(auditLog).values({
      id: workKey('aud'),
      actorId: userId,
      action: 's2a.save',
      target: `${workflowId}:${revision}`,
    });
    return publicWorkflow(row!);
  });
}
export async function publishS2a(database: Database, userId: string, id: string, revision: number) {
  const [row] = await database.orm
    .update(s2aWorkflows)
    .set({ publishedRevision: revision })
    .where(
      and(
        eq(s2aWorkflows.id, id),
        eq(s2aWorkflows.revision, revision),
        sql`${s2aWorkflows.projectId} IN (SELECT id FROM projects WHERE user_id=${userId})`,
      ),
    )
    .returning();
  if (!row) throw new MissionError('MISSION_CONFLICT');
  return publicWorkflow(row);
}
export async function runS2a(
  database: Database,
  userId: string,
  id: string,
  input: unknown,
  limits: unknown,
) {
  const body = s2aRunInputSchema.parse(input);
  const missionId = await database.orm.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${body.requestId}`},0))`,
    );
    const [row] = await tx
      .select({ workflow: s2aWorkflows })
      .from(s2aWorkflows)
      .innerJoin(projects, eq(projects.id, s2aWorkflows.projectId))
      .where(and(eq(s2aWorkflows.id, id), eq(projects.userId, userId)))
      .for('share', { of: s2aWorkflows });
    if (!row) throw new MissionError('MISSION_NOT_FOUND');
    const [prior] = await tx
      .select({ mission: missions, execution: s2aExecutions })
      .from(missions)
      .innerJoin(runs, eq(runs.missionId, missions.id))
      .leftJoin(s2aExecutions, eq(s2aExecutions.runId, runs.id))
      .where(
        and(eq(missions.projectId, row.workflow.projectId), eq(missions.requestId, body.requestId)),
      );
    if (prior) {
      const previous = s2aStateSchema.safeParse(prior.execution?.snapshot);
      if (
        prior.mission.source !== 's2a' ||
        !previous.success ||
        previous.data.workflowId !== id ||
        previous.data.revision !== body.revision ||
        valueHash(jsonValue(previous.data.input)) !== valueHash(jsonValue(body.input))
      )
        throw new MissionError('MISSION_CONFLICT');
      return prior.mission.id;
    }
    if (row.workflow.publishedRevision !== body.revision)
      throw new MissionError('MISSION_CONFLICT');
    const [revision] = await tx
      .select()
      .from(s2aRevisions)
      .where(and(eq(s2aRevisions.workflowId, id), eq(s2aRevisions.revision, body.revision)));
    if (!revision) throw new MissionError('MISSION_NOT_FOUND');
    const missionId = await insertMission(
      tx,
      userId,
      {
        projectId: row.workflow.projectId,
        title: `S2A: ${row.workflow.name}`,
        goal: `Run S2A workflow ${row.workflow.name}, revision ${body.revision}.`,
        agent: 'cos',
        requestId: body.requestId,
      },
      limits,
      's2a',
    );
    const [mission] = await tx.select().from(missions).where(eq(missions.id, missionId));
    if (mission?.source !== 's2a') throw new MissionError('MISSION_CONFLICT');
    const [run] = await tx.select().from(runs).where(eq(runs.missionId, missionId));
    const snapshot = s2aStateSchema.parse({
      workflowId: id,
      revision: body.revision,
      graph: revision.graph,
      input: body.input,
      next: (revision.graph as { entry: string }).entry,
      outputs: {},
      failure: null,
    });
    const [existing] = await tx
      .select()
      .from(s2aExecutions)
      .where(eq(s2aExecutions.runId, run!.id));
    if (existing && valueHash(existing.snapshot) !== valueHash(jsonValue(snapshot)))
      throw new MissionError('MISSION_CONFLICT');
    if (!existing)
      await tx.insert(s2aExecutions).values({
        runId: run!.id,
        workflowId: id,
        revision: body.revision,
        snapshot: jsonValue(snapshot),
      });
    return missionId;
  });
  return (await getMission(database, userId, missionId))!.mission;
}
