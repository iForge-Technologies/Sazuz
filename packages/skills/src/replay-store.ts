import { and, desc, eq, sql } from 'drizzle-orm';
import {
  learnedReplays,
  learnedRepairs,
  browserProfiles,
  projects,
  skills,
  runs,
  missions,
  auditLog,
  executionControl,
  insertMission,
  valueHash,
  workKey,
  type Database,
} from '@sazuz/db';
import {
  learnedReplayInputSchema,
  learnedReplaySchema,
  learnedRepairSchema,
  learnedRevisionInputSchema,
  learnedRepairDecisionSchema,
} from '@sazuz/core/learning-replay';
import { elementFingerprintSchema, LearningError } from '@sazuz/core/learning';
import type { SettingsDocument } from '@sazuz/config/settings';
import { secretRedactor } from '@sazuz/vault';
import { learnedVersion, insertLearnedVersion } from './learning.js';
import { checkedProgram, expandProgram } from './program.js';

export async function replayHistory(
  db: Database,
  userId: string,
  skillId: string,
  replayId?: string,
) {
  await learnedVersion(db, userId, skillId);
  const rows = await db.orm
    .select({ replay: learnedReplays, run: runs })
    .from(learnedReplays)
    .leftJoin(runs, eq(runs.id, learnedReplays.runId))
    .where(
      and(
        eq(learnedReplays.userId, userId),
        eq(learnedReplays.skillId, skillId),
        ...(replayId ? [eq(learnedReplays.id, replayId)] : []),
      ),
    )
    .orderBy(desc(learnedReplays.createdAt))
    .limit(50);
  return rows.map(({ replay, run }) =>
    learnedReplaySchema.parse(
      secretRedactor.redact({
        id: replay.id,
        skillId,
        revision: replay.revision,
        projectId: replay.projectId,
        mode: replay.mode,
        runId: replay.runId,
        missionId: run?.missionId ?? null,
        status: run?.status ?? 'simulated',
        evidence: replay.evidence,
        allowRepair: replay.allowRepair,
        privateOnly: replay.privateOnly,
        createdAt: replay.createdAt.toISOString(),
      }),
    ),
  );
}
export async function startLearnedReplay(
  db: Database,
  userId: string,
  skillId: string,
  raw: unknown,
  settings: SettingsDocument,
) {
  const input = learnedReplayInputSchema.parse(raw);
  const version = await learnedVersion(db, userId, skillId, input.revision);
  const expanded = expandProgram(version.program, input.inputs);
  const hash = valueHash({ skillId, ...input });
  const id = await db.orm.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${input.requestId}`},0))`,
    );
    const [prior] = await tx
      .select()
      .from(learnedReplays)
      .where(and(eq(learnedReplays.userId, userId), eq(learnedReplays.requestId, input.requestId)));
    if (prior) {
      if (prior.inputHash !== hash) throw new LearningError('LEARNING_CONFLICT');
      return prior.id;
    }
    const [current] = await tx
      .select()
      .from(skills)
      .where(and(eq(skills.id, skillId), eq(skills.userId, userId)))
      .for('share');
    const [project] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, version.projectId), eq(projects.userId, userId)));
    if (!current?.enabled || !project) throw new LearningError('LEARNING_DENIED');
    let runId: string | null = null;
    if (input.mode === 'live') {
      const [collision] = await tx
        .select({ id: missions.id })
        .from(missions)
        .where(and(eq(missions.projectId, project.id), eq(missions.requestId, input.requestId)));
      if (collision) throw new LearningError('LEARNING_CONFLICT');
      const [control] = await tx.select().from(executionControl).limit(1);
      if (control?.paused) throw new LearningError('LEARNING_LIMIT');
      const [profile] = await tx
        .select()
        .from(browserProfiles)
        .where(and(eq(browserProfiles.id, input.profileId!), eq(browserProfiles.userId, userId)))
        .for('share');
      if (
        !profile ||
        profile.projectId !== project.id ||
        profile.site !== version.program.site ||
        profile.agentId !== 'operator' ||
        profile.retired ||
        (profile.expiresAt && profile.expiresAt.getTime() <= Date.now())
      )
        throw new LearningError('LEARNING_DENIED');
      const caps = settings.budgets.value;
      const missionId = await insertMission(
        tx,
        userId,
        {
          projectId: project.id,
          requestId: input.requestId,
          agent: 'operator',
          title: `Replay ${version.skill.name}`,
          goal: `Execute reviewed learned skill ${version.skill.name}, revision ${input.revision}, on ${version.program.site}. Every action must have a confirmed receipt.`,
        },
        {
          maxSteps: caps.maxSteps,
          maxCostUsd: caps.perRunUsd,
          maxWallTimeSeconds: caps.maxWallTimeSeconds,
        },
        'learned-skill',
        true,
      );
      const [run] = await tx.select().from(runs).where(eq(runs.missionId, missionId));
      if (!run) throw new LearningError('LEARNING_CONFLICT');
      // A request ID used by an ordinary mission must never attach a learned program to that run.
      if (run.checkpoint || run.status !== 'queued') throw new LearningError('LEARNING_CONFLICT');
      runId = run.id;
    }
    const replayId = workKey('lrp');
    await tx.insert(learnedReplays).values({
      id: replayId,
      userId,
      projectId: project.id,
      skillId,
      revision: input.revision,
      requestId: input.requestId,
      inputHash: hash,
      inputs: input.inputs,
      mode: input.mode,
      profileId: input.mode === 'live' ? input.profileId! : null,
      runId,
      privateOnly:
        version.skill.privateOnly || current.privateOnly || project.privacy === 'private',
      allowRepair: input.allowRepair,
      evidence:
        input.mode === 'rehearsal'
          ? expanded.map(({ step, iteration }) => ({
              stepId: step.id,
              iteration,
              operation: step.operation,
              intent: step.intent,
              target: step.target?.name ?? step.url!,
              parameter: step.parameter,
              result: 'simulated',
            }))
          : [],
    });
    await tx.insert(auditLog).values({
      id: workKey('aud'),
      actorId: userId,
      action: `skill.learned.${input.mode}`,
      target: replayId,
    });
    return replayId;
  });
  const result = (await replayHistory(db, userId, skillId, id)).find((row) => row.id === id);
  if (!result) throw new LearningError('LEARNING_NOT_FOUND');
  return result;
}
export async function reviseLearnedSkill(
  db: Database,
  userId: string,
  skillId: string,
  raw: unknown,
) {
  const input = learnedRevisionInputSchema.parse(raw);
  const prior = await learnedVersion(db, userId, skillId, input.expectedRevision);
  if (input.program.site !== prior.program.site) throw new LearningError('LEARNING_INVALID');
  const saved = await db.orm.transaction(async (tx) => {
    const value = await insertLearnedVersion(tx, userId, {
      id: skillId,
      expectedRevision: input.expectedRevision,
      name: prior.skill.name,
      description: input.description,
      program: input.program,
      projectId: prior.projectId,
      recordingId: prior.recordingId,
      privateOnly: prior.skill.privateOnly,
      enabled: input.enabled,
    });
    await tx.insert(auditLog).values({
      id: workKey('aud'),
      actorId: userId,
      action: 'skill.learned.revised',
      target: skillId,
    });
    return value;
  });
  return learnedVersion(db, userId, skillId, saved.revision);
}
export const publicLearnedRepair = (row: typeof learnedRepairs.$inferSelect) =>
  learnedRepairSchema.parse(
    secretRedactor.redact({
      id: row.id,
      replayId: row.replayId,
      actionIndex: row.actionIndex,
      stepId: row.stepId,
      status: row.status,
      target: row.target,
      reason: row.reason,
      costUsd: row.costUsd,
      acceptedRevision: row.acceptedRevision,
    }),
  );
export async function listLearnedRepairs(db: Database, userId: string, skillId: string) {
  await learnedVersion(db, userId, skillId);
  await db.orm
    .update(learnedRepairs)
    .set({
      status: 'failed',
      reason:
        'This repair was interrupted. It will not repeat automatically; usage may be incomplete.',
    })
    .where(
      and(
        eq(learnedRepairs.status, 'generating'),
        sql`${learnedRepairs.createdAt}<now()-interval '90 seconds'`,
        sql`${learnedRepairs.replayId} IN (SELECT ${learnedReplays.id} FROM ${learnedReplays} WHERE ${learnedReplays.userId}=${userId} AND ${learnedReplays.skillId}=${skillId})`,
      ),
    );
  const rows = await db.orm
    .select({ repair: learnedRepairs })
    .from(learnedRepairs)
    .innerJoin(learnedReplays, eq(learnedReplays.id, learnedRepairs.replayId))
    .where(and(eq(learnedReplays.userId, userId), eq(learnedReplays.skillId, skillId)))
    .orderBy(desc(learnedRepairs.createdAt))
    .limit(100);
  return rows.map(({ repair }) => publicLearnedRepair(repair));
}
export async function decideLearnedRepair(db: Database, userId: string, id: string, raw: unknown) {
  const input = learnedRepairDecisionSchema.parse(raw),
    hash = valueHash(input);
  const [owned] = await db.orm
    .select({ repair: learnedRepairs, replay: learnedReplays })
    .from(learnedRepairs)
    .innerJoin(learnedReplays, eq(learnedReplays.id, learnedRepairs.replayId))
    .where(and(eq(learnedRepairs.id, id), eq(learnedReplays.userId, userId)));
  if (!owned) throw new LearningError('LEARNING_NOT_FOUND');
  const version = await learnedVersion(db, userId, owned.replay.skillId, owned.replay.revision);
  return db.orm.transaction(async (tx) => {
    const [repair] = await tx
      .select()
      .from(learnedRepairs)
      .where(eq(learnedRepairs.id, id))
      .for('update');
    if (!repair) throw new LearningError('LEARNING_NOT_FOUND');
    if (repair.decisionHash) {
      if (repair.decisionHash !== hash) throw new LearningError('LEARNING_CONFLICT');
      return publicLearnedRepair(repair);
    }
    if (
      repair.status !== 'proposed' ||
      !repair.target ||
      input.expectedRevision !== owned.replay.revision
    )
      throw new LearningError('LEARNING_CONFLICT');
    let revision: number | null = null;
    if (input.action === 'accept') {
      const program = structuredClone(version.program);
      const step = program.steps
        .flatMap((node) => (node.kind === 'loop' ? node.steps : [node]))
        .find((node) => node.id === repair.stepId);
      if (!step?.target) throw new LearningError('LEARNING_CONFLICT');
      step.target = elementFingerprintSchema.parse(repair.target);
      const value = await insertLearnedVersion(tx, userId, {
        id: owned.replay.skillId,
        expectedRevision: input.expectedRevision,
        name: version.skill.name,
        description: version.skill.description,
        program: checkedProgram(program),
        projectId: version.projectId,
        recordingId: version.recordingId,
        privateOnly: version.skill.privateOnly,
        enabled: version.skill.enabled,
      });
      revision = value.revision;
    }
    const [saved] = await tx
      .update(learnedRepairs)
      .set({
        status: input.action === 'accept' ? 'accepted' : 'rejected',
        acceptedRevision: revision,
        decisionHash: hash,
      })
      .where(eq(learnedRepairs.id, id))
      .returning();
    await tx.insert(auditLog).values({
      id: workKey('aud'),
      actorId: userId,
      action: `skill.patch.${input.action}`,
      target: id,
    });
    return publicLearnedRepair(saved!);
  });
}
