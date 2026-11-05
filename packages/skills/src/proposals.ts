import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  auditLog,
  projects,
  runs,
  missions,
  skillProposals,
  valueHash,
  workKey,
  type Database,
} from '@sazuz/db';
import {
  proposalDecisionSchema,
  proposalSourcesSchema,
  skillProposalSchema,
} from '@sazuz/core/proposals';
import { secretRedactor } from '@sazuz/vault';
import { SkillError } from './errors.js';
import { parseSkill } from './loader.js';
import { writeSkillIn } from './store.js';

const privacySchema = z.object({ loop: z.object({ privateOnly: z.boolean() }) });
export async function listSkillProposals(
  db: Database,
  userId: string,
  projectId: string,
  id?: string,
) {
  const [project] = await db.orm
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  if (!project) throw new SkillError('SKILL_NOT_FOUND');
  const rows = await db.orm
    .select()
    .from(skillProposals)
    .where(
      and(
        eq(skillProposals.userId, userId),
        eq(skillProposals.projectId, projectId),
        ...(id ? [eq(skillProposals.id, id)] : []),
      ),
    )
    .orderBy(desc(skillProposals.createdAt))
    .limit(50);
  return rows.map((row) =>
    skillProposalSchema.parse(
      secretRedactor.redact({
        id: row.id,
        projectId,
        status: row.status,
        markdown: row.markdown,
        sources: proposalSourcesSchema.parse(row.sources),
        planSignature: row.planSignature,
        privateOnly: row.privateOnly || project.privacy === 'private',
        skillId: row.skillId,
        revision: row.revision,
        createdAt: row.createdAt.toISOString(),
      }),
    ),
  );
}
export async function decideSkillProposal(db: Database, userId: string, id: string, raw: unknown) {
  const input = proposalDecisionSchema.parse(raw),
    hash = valueHash(input);
  const document = input.action === 'accept' ? parseSkill(input.markdown) : null;
  const projectId = await db.orm.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(skillProposals)
      .where(and(eq(skillProposals.id, id), eq(skillProposals.userId, userId)))
      .for('update');
    if (!row) throw new SkillError('SKILL_NOT_FOUND');
    if (row.status !== 'proposed') {
      if (row.decisionHash !== hash) throw new SkillError('SKILL_CONFLICT');
      return row.projectId;
    }
    let saved: { id: string; revision: number } | null = null;
    if (input.action === 'accept' && document) {
      const sources = proposalSourcesSchema.parse(row.sources);
      const owned = await tx
        .select({ project: projects, run: runs, mission: missions })
        .from(runs)
        .innerJoin(missions, eq(missions.id, runs.missionId))
        .innerJoin(projects, eq(projects.id, missions.projectId))
        .where(
          and(
            eq(projects.id, row.projectId),
            eq(projects.userId, userId),
            inArray(
              runs.id,
              sources.map((source) => source.runId),
            ),
          ),
        );
      if (
        owned.length !== 3 ||
        sources.some((source) => {
          const item = owned.find(({ run }) => run.id === source.runId);
          return (
            !item ||
            item.run.status !== 'completed' ||
            item.mission.id !== source.missionId ||
            valueHash(item.mission.goal) !== source.goalHash
          );
        })
      )
        throw new SkillError('SKILL_CONFLICT');
      const privateOnly =
        input.privateOnly ||
        row.privateOnly ||
        sources.some((source) => source.privateOnly) ||
        owned.some(({ project, run }) => {
          const privacy = privacySchema.safeParse(run.checkpoint);
          return project.privacy === 'private' || !privacy.success || privacy.data.loop.privateOnly;
        });
      saved = await writeSkillIn(tx, userId, document, {
        expectedRevision: 0,
        enabled: input.enabled,
        privateOnly,
        source: 'proposed',
      });
      await tx.update(skillProposals).set({ privateOnly }).where(eq(skillProposals.id, id));
    }
    await tx
      .update(skillProposals)
      .set({
        status: input.action === 'accept' ? 'accepted' : 'rejected',
        decisionHash: hash,
        ...(saved
          ? { skillId: saved.id, revision: saved.revision, markdown: document!.markdown }
          : {}),
      })
      .where(eq(skillProposals.id, id));
    await tx.insert(auditLog).values({
      id: workKey('aud'),
      actorId: userId,
      action: `skill.proposal.${input.action}ed`,
      target: id,
    });
    return row.projectId;
  });
  return (await listSkillProposals(db, userId, projectId, id))[0]!;
}
