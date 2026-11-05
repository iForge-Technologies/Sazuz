import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  auditLog,
  skills,
  skillVersions,
  skillSelections,
  skillProposals,
  projects,
  users,
  workKey,
  type Database,
  type Transaction,
} from '@sazuz/db';
import {
  skillManifestSchema,
  skillSummarySchema,
  skillVersionSchema,
  skillWriteSchema,
  type SkillVersion,
} from '@sazuz/core/skills';
import { secretRedactor } from '@sazuz/vault';
import { parseSkill, readBuiltinSkills } from './loader.js';
import { SkillError } from './errors.js';

type SkillRow = typeof skills.$inferSelect;
function summary(row: SkillRow) {
  return skillSummarySchema.parse({
    id: row.id,
    name: secretRedactor.redactText(row.name),
    description: secretRedactor.redactText(row.description),
    revision: row.revision,
    source: row.source,
    enabled: row.enabled,
    privateOnly: row.privateOnly,
    updatedAt: row.updatedAt.toISOString(),
  });
}
export async function ensureBuiltinSkills(db: Database, directory?: string) {
  const documents = await readBuiltinSkills(directory);
  await db.orm.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('sazuz:built-in-skills'))`);
    for (const document of documents) {
      const [prior] = await tx.select().from(skills).where(eq(skills.id, document.id));
      const [version] = prior
        ? await tx
            .select()
            .from(skillVersions)
            .where(
              and(eq(skillVersions.skillId, prior.id), eq(skillVersions.revision, prior.revision)),
            )
        : [];
      if (version?.sha256 === document.sha256) continue;
      const revision = (prior?.revision ?? 0) + 1;
      if (!prior)
        await tx.insert(skills).values({
          id: document.id,
          name: document.manifest.name,
          description: document.manifest.description,
          source: 'builtin',
          revision,
        });
      else
        await tx
          .update(skills)
          .set({ description: document.manifest.description, revision, updatedAt: new Date() })
          .where(eq(skills.id, prior.id));
      await tx.insert(skillVersions).values({
        skillId: document.id,
        revision,
        markdown: document.markdown,
        manifest: document.manifest,
        sha256: document.sha256,
      });
    }
  });
}
export async function listSkills(db: Database, userId: string) {
  await ensureBuiltinSkills(db);
  return (
    await db.orm
      .select()
      .from(skills)
      .where(or(isNull(skills.userId), eq(skills.userId, userId)))
      .orderBy(desc(skills.updatedAt), skills.name)
      .limit(205)
  ).map(summary);
}
export async function skillVersion(
  db: Database,
  userId: string,
  id: string,
  revision?: number,
): Promise<SkillVersion> {
  const [row] = await db.orm
    .select()
    .from(skills)
    .where(and(eq(skills.id, id), or(isNull(skills.userId), eq(skills.userId, userId))));
  if (!row) throw new SkillError('SKILL_NOT_FOUND');
  const [version] = await db.orm
    .select()
    .from(skillVersions)
    .where(
      and(eq(skillVersions.skillId, id), eq(skillVersions.revision, revision ?? row.revision)),
    );
  if (!version) throw new SkillError('SKILL_NOT_FOUND');
  const sources =
    row.source === 'proposed'
      ? await db.orm
          .select({ privateOnly: skillProposals.privateOnly, privacy: projects.privacy })
          .from(skillProposals)
          .innerJoin(projects, eq(projects.id, skillProposals.projectId))
          .where(
            and(
              eq(skillProposals.skillId, id),
              eq(skillProposals.userId, userId),
              eq(skillProposals.status, 'accepted'),
            ),
          )
      : [];
  const manifest = skillManifestSchema.parse(secretRedactor.redact(version.manifest));
  return skillVersionSchema.parse({
    ...summary(row),
    name: manifest.name,
    description: manifest.description,
    revision: version.revision,
    updatedAt: version.createdAt.toISOString(),
    privateOnly:
      row.privateOnly ||
      version.privateOnly ||
      sources.some((source) => source.privateOnly || source.privacy === 'private'),
    manifest,
    markdown: secretRedactor.redactText(version.markdown),
    sha256: version.sha256,
  });
}
export async function versions(db: Database, userId: string, id: string) {
  await skillVersion(db, userId, id);
  return (
    await db.orm
      .select({
        revision: skillVersions.revision,
        sha256: skillVersions.sha256,
        createdAt: skillVersions.createdAt,
      })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, id))
      .orderBy(desc(skillVersions.revision))
      .limit(100)
  ).map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}
export async function writeSkillIn(
  tx: Transaction,
  userId: string,
  document: ReturnType<typeof parseSkill>,
  value: {
    expectedRevision: number;
    enabled: boolean;
    privateOnly: boolean;
    source: 'user' | 'style' | 'learned' | 'proposed';
    id?: string;
  },
) {
  const [owner] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  if (!owner) throw new SkillError('SKILL_NOT_FOUND');
  const [reserved] = await tx
    .select({ id: skills.id })
    .from(skills)
    .where(and(isNull(skills.userId), eq(skills.name, document.manifest.name)));
  if (reserved) throw new SkillError('SKILL_CONFLICT');
  const [prior] = await tx
    .select()
    .from(skills)
    .where(
      and(
        eq(skills.userId, userId),
        value.id ? eq(skills.id, value.id) : eq(skills.name, document.manifest.name),
      ),
    )
    .for('update');
  if (
    (prior?.revision ?? 0) !== value.expectedRevision ||
    (value.id && !prior) ||
    (prior && prior.name !== document.manifest.name)
  )
    throw new SkillError('SKILL_CONFLICT');
  if (
    document.manifest.name === 'writing-style' &&
    (prior ? prior.source !== 'style' : value.source !== 'style')
  )
    throw new SkillError('SKILL_CONFLICT');
  if (
    !prior &&
    (await tx.select({ id: skills.id }).from(skills).where(eq(skills.userId, userId)).limit(200))
      .length >= 200
  )
    throw new SkillError('SKILL_LIMIT');
  const id = prior?.id ?? workKey('skl'),
    revision = (prior?.revision ?? 0) + 1;
  const update = {
    description: document.manifest.description,
    revision,
    enabled: value.enabled,
    privateOnly: value.privateOnly,
    updatedAt: new Date(),
  };
  if (prior) await tx.update(skills).set(update).where(eq(skills.id, id));
  else
    await tx
      .insert(skills)
      .values({ id, userId, name: document.manifest.name, source: value.source, ...update });
  await tx.insert(skillVersions).values({
    skillId: id,
    revision,
    markdown: document.markdown,
    manifest: document.manifest,
    sha256: document.sha256,
    privateOnly: value.privateOnly,
  });
  await tx
    .insert(auditLog)
    .values({ id: workKey('aud'), actorId: userId, action: 'skill.version.created', target: id });
  return { id, revision };
}
export async function saveSkill(db: Database, userId: string, input: unknown, id?: string) {
  const value = skillWriteSchema.parse(input),
    document = parseSkill(value.markdown);
  if (!id && document.manifest.name === 'writing-style') throw new SkillError('SKILL_CONFLICT');
  if (id && (await skillVersion(db, userId, id)).source === 'learned')
    throw new SkillError('SKILL_CONFLICT');
  await ensureBuiltinSkills(db);
  const saved = await db.orm.transaction((tx) =>
    writeSkillIn(tx, userId, document, { ...value, source: 'user', ...(id ? { id } : {}) }),
  );
  return skillVersion(db, userId, saved.id, saved.revision);
}
export async function selectSkill(
  db: Database,
  userId: string,
  input: { name: string; revision?: number | undefined },
  execution: { runId: string; key: string },
) {
  const [prior] = await db.orm
    .select()
    .from(skillSelections)
    .where(eq(skillSelections.key, execution.key));
  if (prior) {
    if (prior.runId !== execution.runId) throw new SkillError('SKILL_CONFLICT');
    const selected = await skillVersion(db, userId, prior.skillId, prior.revision);
    if (
      selected.name !== input.name ||
      (input.revision !== undefined && input.revision !== selected.revision) ||
      prior.sha256 !== selected.sha256
    )
      throw new SkillError('SKILL_CONFLICT');
    return selected;
  }
  const entry = (await listSkills(db, userId)).find(
    (skill) => skill.name === input.name && skill.enabled,
  );
  if (!entry) throw new SkillError('SKILL_NOT_FOUND');
  const selected = await skillVersion(db, userId, entry.id, input.revision);
  await db.orm
    .insert(skillSelections)
    .values({
      key: execution.key,
      runId: execution.runId,
      skillId: selected.id,
      revision: selected.revision,
      sha256: selected.sha256,
    })
    .onConflictDoNothing();
  // A concurrent attempt must use the same pinned revision, even if the skill was edited meanwhile.
  return selectSkill(db, userId, input, execution);
}
