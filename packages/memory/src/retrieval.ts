import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  kbChunks,
  kbEmbeddings,
  kbSources,
  memories,
  memoryEmbeddings,
  type Database,
} from '@sazuz/db';
import { knowledgeSearchSchema, knowledgeSearchResultSchema } from '@sazuz/core/knowledge';
import { memorySearchSchema, type Memory } from '@sazuz/core/memory';
import { activeGeneration, type EmbedBatch } from './indexing.js';
import { publicMemory, requireProject, searchMemories } from './store.js';
import { publicChunk } from './sources.js';
import { MemoryError } from './errors.js';

export function reciprocalRankFusion(lists: string[][]): string[] {
  const scores = new Map<string, number>();
  for (const list of lists)
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + index + 1)));
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}
export function contextBudget<T>(values: T[], tokens: number): T[] {
  let remaining = tokens;
  return values.filter((value) => {
    const size = Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 3);
    if (size > remaining) return false;
    remaining -= size;
    return true;
  });
}
async function queryVector(
  db: Database,
  projectId: string,
  query: string,
  privateOnly: boolean,
  embed?: EmbedBatch,
) {
  const generation = await activeGeneration(db, projectId);
  if (!generation?.dimensions || !embed)
    return {
      generation,
      vector: null,
      notice:
        'Full-text search. Configure an embedding model and finish indexing for semantic matches.',
    };
  try {
    const result = await embed(
      {
        providerId: generation.providerId,
        modelId: generation.modelId,
        providerUrl: generation.providerUrl,
        locality: privateOnly ? 'local' : 'cloud',
      },
      [query],
      privateOnly,
    );
    const vector = result.vectors[0];
    if (
      result.providerId !== generation.providerId ||
      result.modelId !== generation.modelId ||
      result.vectors.length !== 1 ||
      !vector ||
      vector.length !== generation.dimensions ||
      vector.some((value) => !Number.isFinite(value)) ||
      !vector.some((value) => value !== 0)
    )
      throw new MemoryError('EMBEDDING_SPACE');
    return { generation, vector, notice: null };
  } catch {
    db.logger.warn(
      { code: 'RETRIEVAL_FULL_TEXT', projectId },
      'Semantic search is unavailable; using full-text retrieval.',
    );
    return {
      generation,
      vector: null,
      notice: 'Semantic search is unavailable. These are full-text matches.',
    };
  }
}
export async function searchKnowledge(
  db: Database,
  userId: string,
  input: unknown,
  embed?: EmbedBatch,
) {
  const query = knowledgeSearchSchema.parse(input);
  const project = await requireProject(db, userId, query.projectId);
  const selection = await queryVector(
    db,
    project.id,
    query.query,
    project.privacy === 'private',
    embed,
  );
  const lexical = await db.orm
    .select({ chunk: kbChunks, source: kbSources })
    .from(kbChunks)
    .innerJoin(kbSources, eq(kbSources.id, kbChunks.sourceId))
    .where(
      and(
        eq(kbChunks.projectId, project.id),
        eq(kbSources.userId, userId),
        eq(kbSources.status, 'ready'),
        sql`to_tsvector('simple', ${kbChunks.text}) @@ plainto_tsquery('simple', ${query.query})`,
      ),
    )
    .orderBy(
      desc(
        sql`ts_rank(to_tsvector('simple', ${kbChunks.text}), plainto_tsquery('simple', ${query.query}))`,
      ),
      desc(kbChunks.id),
    )
    .limit(40);
  const semantic =
    selection.vector && selection.generation
      ? await db.orm
          .select({ chunk: kbChunks, source: kbSources })
          .from(kbEmbeddings)
          .innerJoin(kbChunks, eq(kbChunks.id, kbEmbeddings.chunkId))
          .innerJoin(kbSources, eq(kbSources.id, kbChunks.sourceId))
          .where(
            and(
              eq(kbEmbeddings.generationId, selection.generation.id),
              eq(kbChunks.projectId, project.id),
              eq(kbSources.userId, userId),
              eq(kbSources.status, 'ready'),
            ),
          )
          .orderBy(
            sql`${kbEmbeddings.vector} <=> ${JSON.stringify(selection.vector)}::vector`,
            desc(kbChunks.id),
          )
          .limit(40)
      : [];
  const rows = new Map([...lexical, ...semantic].map((row) => [row.chunk.id, row]));
  const ranked = reciprocalRankFusion([
    lexical.map((row) => row.chunk.id),
    semantic.map((row) => row.chunk.id),
  ])
    .map((id) => rows.get(id)!)
    .map(({ chunk, source }) => publicChunk(chunk, source));
  return knowledgeSearchResultSchema.parse({
    mode: selection.vector ? 'hybrid' : 'full-text',
    generationId: selection.vector ? selection.generation.id : null,
    notice: selection.notice,
    matches: contextBudget(ranked, query.tokenBudget).slice(0, query.limit),
  });
}
export async function hybridMemorySearch(
  db: Database,
  userId: string,
  input: unknown,
  embed?: EmbedBatch,
): Promise<Memory[]> {
  const query = memorySearchSchema.parse(input);
  const project = await requireProject(db, userId, query.projectId);
  const lexical = await searchMemories(db, userId, { ...query, tokenBudget: 3000 });
  if (!query.query) return contextBudget(lexical, query.tokenBudget);
  const selection = await queryVector(
    db,
    project.id,
    query.query,
    project.privacy === 'private' || lexical.some((memory) => memory.sensitivity === 'private'),
    embed,
  );
  if (!selection.vector || !selection.generation) return contextBudget(lexical, query.tokenBudget);
  const semantic = (
    await db.orm
      .select({ memory: memories })
      .from(memoryEmbeddings)
      .innerJoin(memories, eq(memories.id, memoryEmbeddings.memoryId))
      .where(
        and(
          eq(memoryEmbeddings.generationId, selection.generation.id),
          eq(memories.userId, userId),
          eq(memories.status, 'accepted'),
          sql`${memoryEmbeddings.memoryVersion}=${memories.version}`,
          or(isNull(memories.projectId), eq(memories.projectId, project.id)),
          or(isNull(memories.agentId), eq(memories.agentId, query.agentId)),
        ),
      )
      .orderBy(sql`${memoryEmbeddings.vector} <=> ${JSON.stringify(selection.vector)}::vector`)
      .limit(40)
  ).map(({ memory }) => publicMemory(memory));
  const rows = new Map([...lexical, ...semantic].map((memory) => [memory.id, memory]));
  const ids = reciprocalRankFusion([
    lexical.map((memory) => memory.id),
    semantic.map((memory) => memory.id),
  ]);
  const ranked = ids
    .map((id, rank) => ({ memory: rows.get(id)!, rank }))
    .sort((a, b) => {
      const score = (entry: typeof a) =>
        1 / (entry.rank + 1) +
        entry.memory.importance * 0.05 +
        0.02 / (1 + Math.max(0, Date.now() - Date.parse(entry.memory.updatedAt)) / 86400000);
      return score(b) - score(a);
    })
    .map(({ memory }) => memory);
  return contextBudget(ranked, query.tokenBudget);
}
