import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  embeddingGenerations,
  kbChunks,
  kbEmbeddings,
  kbSources,
  knowledgeJobs,
  memories,
  memoryEmbeddings,
  projects,
  workKey,
  type Database,
} from '@sazuz/db';
import type { SettingsDocument } from '@sazuz/config/settings';
import { generationSchema } from '@sazuz/core/knowledge';
import { embeddingVectorsSchema, type EmbeddingResult } from '@sazuz/llm';
import { MemoryError } from './errors.js';
import { requireProject } from './store.js';

export interface EmbeddingTarget {
  providerId: string;
  modelId: string;
  providerUrl: string;
  locality: 'cloud' | 'local';
}
export type EmbedBatch = (
  target: EmbeddingTarget,
  texts: string[],
  privateOnly: boolean,
) => Promise<EmbeddingResult>;
export function embeddingTarget(settings: SettingsDocument): EmbeddingTarget | null {
  const override = settings.memory.value.embeddingModel;
  const separator = override?.indexOf('/') ?? -1;
  if (override && separator < 1) throw new MemoryError('EMBEDDING_UNAVAILABLE');
  const role =
    override && separator > 0
      ? { providerId: override.slice(0, separator), modelId: override.slice(separator + 1) }
      : settings.models.value.roles.embedding;
  if (!role) return null;
  const provider = settings.providers.value.items.find(
    (entry) => entry.id === role.providerId && entry.enabled,
  );
  if (!provider || !role.modelId) throw new MemoryError('EMBEDDING_UNAVAILABLE');
  return { ...role, providerUrl: provider.baseUrl, locality: provider.locality };
}
type CorpusEntry = { kind: 'memory' | 'chunk'; id: string; version: number; text: string };
async function corpus(
  db: Database,
  projectId: string,
  userId: string,
  local: boolean,
): Promise<CorpusEntry[]> {
  const memoryRows = await db.orm
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        eq(memories.status, 'accepted'),
        or(isNull(memories.projectId), eq(memories.projectId, projectId)),
        local ? undefined : eq(memories.sensitivity, 'low'),
      ),
    )
    .orderBy(asc(memories.id))
    .limit(6001);
  const chunkRows = await db.orm
    .select({ chunk: kbChunks })
    .from(kbChunks)
    .innerJoin(kbSources, eq(kbSources.id, kbChunks.sourceId))
    .where(and(eq(kbChunks.projectId, projectId), eq(kbSources.status, 'ready')))
    .orderBy(asc(kbChunks.id))
    .limit(6001);
  if (memoryRows.length + chunkRows.length > 6000) throw new MemoryError('SOURCE_INVALID');
  return [
    ...memoryRows.map((row): CorpusEntry => ({
      kind: 'memory',
      id: row.id,
      version: row.version,
      text: row.content,
    })),
    ...chunkRows.map(({ chunk }): CorpusEntry => ({
      kind: 'chunk',
      id: chunk.id,
      version: 1,
      text: chunk.text,
    })),
  ];
}
function fingerprint(target: EmbeddingTarget, entries: CorpusEntry[]) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        target.providerId,
        target.modelId,
        target.providerUrl,
        entries.map(({ kind, id, version }) => [kind, id, version]),
      ]),
    )
    .digest('hex');
}
export async function queueReindex(
  db: Database,
  userId: string,
  projectId: string,
  settings: SettingsDocument,
  force = false,
) {
  const project = await requireProject(db, userId, projectId);
  const target = embeddingTarget(settings);
  if (!target) throw new MemoryError('EMBEDDING_UNAVAILABLE');
  if (
    (project.privacy === 'private' || settings.models.value.preset === 'private') &&
    target.locality !== 'local'
  )
    throw new MemoryError('EMBEDDING_PRIVATE');
  const entries = await corpus(db, projectId, userId, target.locality === 'local');
  const base = fingerprint(target, entries);
  return db.orm.transaction(async (tx) => {
    await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update');
    const existing = await tx
      .select()
      .from(embeddingGenerations)
      .where(
        and(
          eq(embeddingGenerations.projectId, projectId),
          sql`split_part(${embeddingGenerations.fingerprint}, ':', 1)=${base}`,
        ),
      )
      .orderBy(sql`${embeddingGenerations.createdAt} DESC`)
      .limit(1);
    if (!force && existing[0]) return existing[0];
    const [generation] = await tx
      .insert(embeddingGenerations)
      .values({
        id: workKey('gen'),
        projectId,
        fingerprint: force ? `${base}:${randomUUID()}` : base,
        providerId: target.providerId,
        modelId: target.modelId,
        providerUrl: target.providerUrl,
      })
      .returning();
    await tx.insert(knowledgeJobs).values({
      id: workKey('job'),
      eventKey: `reindex:${generation!.id}`,
      userId,
      projectId,
      kind: 'reindex',
      payload: { kind: 'reindex', generationId: generation!.id },
      providerId: target.providerId,
      modelId: target.modelId,
      maxCostUsd: settings.budgets.value.perRunUsd,
    });
    return generation!;
  });
}
export async function syncIndexes(db: Database, settings: SettingsDocument) {
  // Retention is a user-configured local maintenance operation; receipts contain no forgotten content.
  await db.orm
    .delete(memories)
    .where(
      sql`${memories.updatedAt} < now() - ${settings.memory.value.retentionDays} * interval '1 day'`,
    );
  const target = embeddingTarget(settings);
  if (!target) return;
  for (const project of await db.orm.select().from(projects)) {
    if (
      (project.privacy === 'private' || settings.models.value.preset === 'private') &&
      target.locality !== 'local'
    )
      continue;
    await queueReindex(db, project.userId, project.id, settings);
  }
}
export async function listGenerations(db: Database, userId: string, projectId: string) {
  await requireProject(db, userId, projectId);
  return (
    await db.orm
      .select()
      .from(embeddingGenerations)
      .where(eq(embeddingGenerations.projectId, projectId))
      .orderBy(sql`${embeddingGenerations.createdAt} DESC`)
      .limit(10)
  ).map((row) =>
    generationSchema.parse({
      id: row.id,
      projectId: row.projectId,
      providerId: row.providerId,
      modelId: row.modelId,
      status: row.status,
      dimensions: row.dimensions,
      createdAt: row.createdAt.toISOString(),
    }),
  );
}
export async function activeGeneration(db: Database, projectId: string) {
  return (
    await db.orm
      .select()
      .from(embeddingGenerations)
      .where(
        and(
          eq(embeddingGenerations.projectId, projectId),
          eq(embeddingGenerations.status, 'active'),
        ),
      )
      .limit(1)
  )[0];
}
export async function buildIndex(
  db: Database,
  generationId: string,
  getSettings: () => SettingsDocument,
  embed: EmbedBatch,
  signal: AbortSignal,
) {
  const [generation] = await db.orm
    .select()
    .from(embeddingGenerations)
    .where(eq(embeddingGenerations.id, generationId));
  if (!generation) throw new MemoryError('SOURCE_NOT_FOUND');
  if (generation.status === 'active') return;
  const [project] = await db.orm
    .select()
    .from(projects)
    .where(eq(projects.id, generation.projectId));
  if (!project) throw new MemoryError('SOURCE_NOT_FOUND');
  const configured = () => {
    const target = embeddingTarget(getSettings());
    if (
      !target ||
      target.providerId !== generation.providerId ||
      target.modelId !== generation.modelId ||
      target.providerUrl !== generation.providerUrl
    )
      throw new MemoryError('EMBEDDING_SPACE');
    if (
      (project.privacy === 'private' || getSettings().models.value.preset === 'private') &&
      target.locality !== 'local'
    )
      throw new MemoryError('EMBEDDING_PRIVATE');
    return target;
  };
  const target = configured();
  const entries = await corpus(db, project.id, project.userId, target.locality === 'local');
  if (fingerprint(target, entries) !== generation.fingerprint.split(':')[0])
    throw new MemoryError('EMBEDDING_SPACE');
  const savedMemories = await db.orm
    .select()
    .from(memoryEmbeddings)
    .where(eq(memoryEmbeddings.generationId, generationId));
  const savedChunks = await db.orm
    .select()
    .from(kbEmbeddings)
    .where(eq(kbEmbeddings.generationId, generationId));
  const pending = entries.filter((entry) =>
    entry.kind === 'memory'
      ? !savedMemories.some(
          (row) => row.memoryId === entry.id && row.memoryVersion === entry.version,
        )
      : !savedChunks.some((row) => row.chunkId === entry.id),
  );
  let dimensions = generation.dimensions;
  for (let offset = 0; offset < pending.length; offset += 32) {
    if (signal.aborted) throw new MemoryError('JOB_INTERRUPTED');
    configured();
    const batch = pending.slice(offset, offset + 32);
    const result = await embed(
      target,
      batch.map((entry) => entry.text),
      project.privacy === 'private',
    );
    const vectors = embeddingVectorsSchema.parse(result.vectors);
    const size = vectors[0]!.length;
    if (
      result.providerId !== target.providerId ||
      result.modelId !== target.modelId ||
      result.dimensions !== size ||
      vectors.length !== batch.length ||
      vectors.some((vector) => vector.length !== size) ||
      (dimensions !== null && dimensions !== size)
    )
      throw new MemoryError('EMBEDDING_SPACE');
    dimensions = size;
    await db.orm.transaction(async (tx) => {
      await tx
        .update(embeddingGenerations)
        .set({ dimensions: size, status: 'building' })
        .where(eq(embeddingGenerations.id, generationId));
      for (const [index, entry] of batch.entries()) {
        const vector = vectors[index]!;
        const embeddingModel = `${target.providerId}/${target.modelId}`;
        if (entry.kind === 'memory') {
          const [live] = await tx
            .select()
            .from(memories)
            .where(
              and(
                eq(memories.id, entry.id),
                eq(memories.version, entry.version),
                eq(memories.status, 'accepted'),
              ),
            )
            .for('share');
          if (live)
            await tx
              .insert(memoryEmbeddings)
              .values({
                memoryId: entry.id,
                memoryVersion: entry.version,
                generationId,
                embeddingModel,
                vector,
              })
              .onConflictDoNothing();
        } else {
          const [live] = await tx
            .select({ id: kbChunks.id })
            .from(kbChunks)
            .where(eq(kbChunks.id, entry.id))
            .for('share');
          if (live)
            await tx
              .insert(kbEmbeddings)
              .values({ chunkId: entry.id, generationId, embeddingModel, vector })
              .onConflictDoNothing();
        }
      }
    });
  }
  configured();
  if (
    fingerprint(
      target,
      await corpus(db, project.id, project.userId, target.locality === 'local'),
    ) !== generation.fingerprint.split(':')[0]
  )
    throw new MemoryError('EMBEDDING_SPACE');
  await db.orm.transaction(async (tx) => {
    await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, project.id))
      .for('update');
    await tx
      .update(embeddingGenerations)
      .set({ status: 'retired' })
      .where(
        and(
          eq(embeddingGenerations.projectId, project.id),
          eq(embeddingGenerations.status, 'active'),
        ),
      );
    await tx
      .update(embeddingGenerations)
      .set({ status: 'active', dimensions })
      .where(eq(embeddingGenerations.id, generationId));
  });
}
