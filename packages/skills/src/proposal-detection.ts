import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  auditLog,
  missionGraphs,
  missions,
  missionTasks,
  projects,
  runs,
  skillProposals,
  valueHash,
  workKey,
  type Transaction,
} from '@sazuz/db';
import { taskResultSchema } from '@sazuz/core/graphs';
import { proposalFingerprintSchema, proposalSourcesSchema } from '@sazuz/core/proposals';
import { agentRoleSchema } from '@sazuz/core/agents';
import {
  proposalPattern,
  proposedSkillDocument,
  similarProposalPlans,
} from './proposal-pattern.js';

const completionSchema = z.object({
  phase: z.literal('done'),
  loop: z.object({ privateOnly: z.boolean() }),
  plan: z.unknown().optional(),
  results: z
    .array(
      z.object({
        agent: agentRoleSchema,
        text: z.string().min(1).max(100000),
        tainted: z.boolean(),
      }),
    )
    .max(24),
});

/** Run in the same transaction as root completion. No model calls, authority or automatic skill save. */
export async function detectSkillProposal(
  tx: Transaction,
  input: { userId: string; projectId: string; missionId: string },
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`skill-proposals:${input.projectId}`},0))`,
  );
  const [project] = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.userId, input.userId)));
  if (!project) return null;
  const families = await tx
    .select()
    .from(skillProposals)
    .where(
      and(eq(skillProposals.userId, input.userId), eq(skillProposals.projectId, input.projectId)),
    )
    .limit(200);
  if (families.length >= 200) return null;
  const rows = await tx
    .select({
      mission: missions,
      run: {
        id: runs.id,
        checkpoint: sql<unknown>`jsonb_build_object(
        'phase', ${runs.checkpoint}->'phase',
        'loop', jsonb_build_object('privateOnly', ${runs.checkpoint}->'loop'->'privateOnly'),
        'plan', ${runs.checkpoint}->'plan', 'results', ${runs.checkpoint}->'results'
      )`,
      },
      graph: missionGraphs,
    })
    .from(missions)
    .innerJoin(runs, and(eq(runs.missionId, missions.id), isNull(runs.parentRunId)))
    .leftJoin(missionGraphs, eq(missionGraphs.missionId, missions.id))
    .where(
      and(
        eq(missions.projectId, project.id),
        eq(missions.agent, 'cos'),
        eq(runs.status, 'completed'),
        sql`${missions.createdAt} >= now() - interval '90 days'`,
        sql`${missions.source} NOT IN ('workflow','learned-skill')`,
      ),
    )
    .orderBy(desc(missions.createdAt), missions.id)
    .limit(50);
  if (rows.length < 3) return null;
  const taskRows = await tx
    .select({ task: missionTasks, runStatus: runs.status })
    .from(missionTasks)
    .leftJoin(runs, eq(runs.id, missionTasks.runId))
    .where(
      inArray(
        missionTasks.missionId,
        rows.map(({ mission }) => mission.id),
      ),
    );
  const candidates = [];
  for (const { mission, run, graph } of rows) {
    const completion = completionSchema.safeParse(run.checkpoint);
    if (!completion.success) continue;
    const pattern = proposalPattern(mission.goal, graph?.definition ?? completion.data.plan);
    if (!pattern) continue;
    let privateOnly = project.privacy === 'private' || completion.data.loop.privateOnly;
    if (graph) {
      if (graph.rootRunId !== run.id || !('mode' in pattern.plan)) continue;
      const tasks = taskRows.filter(({ task }) => task.missionId === mission.id);
      if (tasks.length !== pattern.plan.tasks.length) continue;
      let complete = true;
      for (const step of pattern.plan.tasks) {
        const task = tasks.find(({ task }) => task.taskKey === step.id);
        const result = taskResultSchema.safeParse(task?.task.result);
        if (
          !task ||
          task.task.status !== 'completed' ||
          task.runStatus !== 'completed' ||
          !result.success ||
          result.data.taskId !== step.id ||
          result.data.agent !== step.agent ||
          !result.data.text.trim()
        ) {
          complete = false;
          break;
        }
        privateOnly ||= result.data.privateOnly;
      }
      if (!complete) continue;
    } else if (
      completion.data.results.length !== pattern.plan.tasks.length ||
      pattern.plan.tasks.some(
        (task, index) =>
          completion.data.results[index]?.agent !== task.agent ||
          !completion.data.results[index]?.text.trim(),
      )
    )
      continue;
    candidates.push({
      pattern,
      goal: mission.goal,
      source: {
        missionId: mission.id,
        runId: run.id,
        planRevision: graph?.revision ?? null,
        planHash: pattern.planHash,
        goalHash: valueHash(mission.goal),
        privateOnly,
      },
    });
  }
  const current = candidates.find((candidate) => candidate.source.missionId === input.missionId);
  if (!current) return null;
  for (const family of families) {
    const fingerprint = proposalFingerprintSchema.parse(family.fingerprint);
    if (similarProposalPlans(current.pattern.fingerprint, fingerprint)) return null;
  }
  const selected = [current];
  for (const candidate of candidates) {
    if (
      candidate === current ||
      !selected.every((prior) =>
        similarProposalPlans(prior.pattern.fingerprint, candidate.pattern.fingerprint),
      )
    )
      continue;
    selected.push(candidate);
    if (selected.length === 3) break;
  }
  if (selected.length < 3) return null;
  const sources = proposalSourcesSchema.parse(selected.map((candidate) => candidate.source));
  const familyKey = valueHash(current.pattern.fingerprint),
    id = workKey('spp');
  const document = proposedSkillDocument(current.goal, current.pattern, sources, familyKey);
  const [created] = await tx
    .insert(skillProposals)
    .values({
      id,
      userId: input.userId,
      projectId: project.id,
      familyKey,
      planSignature: current.pattern.signature,
      fingerprint: current.pattern.fingerprint,
      sources,
      markdown: document.markdown,
      privateOnly: sources.some((source) => source.privateOnly),
    })
    .onConflictDoNothing()
    .returning({ id: skillProposals.id });
  if (!created) return null;
  await tx.insert(auditLog).values({
    id: workKey('aud'),
    actorId: input.userId,
    action: 'skill.proposal.created',
    target: created.id,
  });
  return created.id;
}
