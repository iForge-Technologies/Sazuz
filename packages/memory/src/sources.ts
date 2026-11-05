import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  auditLog,
  kbSources,
  kbDocuments,
  kbChunks,
  knowledgeJobs,
  workKey,
  type Database,
  type Transaction,
} from '@sazuz/db';
import {
  sourceUploadSchema,
  sourceUrlSchema,
  sourceSchema,
  chunkSchema,
} from '@sazuz/core/knowledge';
import { fetchPublicText, resolvePublicUrl, type SafeNetworkDependencies } from '@sazuz/tools';
import { parseDocument, chunkText, type ParsedSegment } from './parsers.js';
import { MemoryError } from './errors.js';
import { secretRedactor } from '@sazuz/vault';
import { requireProject, safeKnowledgeText } from './store.js';

export async function listSources(db: Database, userId: string, projectId: string) {
  await requireProject(db, userId, projectId);
  const rows = await db.orm
    .select({
      source: kbSources,
      chunkCount: sql<number>`(SELECT count(*)::int FROM kb_chunks WHERE source_id=${kbSources.id})`,
    })
    .from(kbSources)
    .where(and(eq(kbSources.userId, userId), eq(kbSources.projectId, projectId)))
    .orderBy(asc(kbSources.createdAt));
  return rows.map(({ source, chunkCount }) => publicSource(source, chunkCount));
}
function publicSource(row: typeof kbSources.$inferSelect, chunkCount = 0) {
  return sourceSchema.parse({
    id: row.id,
    projectId: row.projectId,
    name: secretRedactor.redactText(row.name),
    kind: row.kind,
    url: row.url === null ? null : secretRedactor.redactText(row.url),
    status: row.status,
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    chunkCount,
  });
}
async function insertSource(
  db: Database,
  userId: string,
  input: { projectId: string; requestId: string; name: string; kind: string; url?: string },
  hash: string,
  segments: ParsedSegment[],
) {
  await requireProject(db, userId, input.projectId);
  safeKnowledgeText(input.name);
  if (input.url) safeKnowledgeText(input.url);
  return db.orm.transaction(async (tx) => {
    const [row] = await tx
      .insert(kbSources)
      .values({ id: workKey('src'), userId, ...input, contentHash: hash })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const [prior] = await tx
        .select()
        .from(kbSources)
        .where(and(eq(kbSources.userId, userId), eq(kbSources.requestId, input.requestId)));
      if (!prior || prior.contentHash !== hash || prior.projectId !== input.projectId)
        throw new MemoryError('SOURCE_CONFLICT');
      return publicSource(prior);
    }
    await insertDocuments(tx, row.id, segments);
    await tx.insert(knowledgeJobs).values({
      id: workKey('job'),
      eventKey: `ingest:${row.id}`,
      userId,
      projectId: input.projectId,
      sourceId: row.id,
      kind: 'ingest',
      payload: { kind: 'ingest', sourceId: row.id },
      maxCostUsd: 0,
    });
    await tx
      .insert(auditLog)
      .values({ id: workKey('aud'), actorId: userId, action: 'kb.source.added', target: row.id });
    return publicSource(row);
  });
}
async function insertDocuments(tx: Transaction, sourceId: string, segments: ParsedSegment[]) {
  if (segments.length)
    await tx
      .insert(kbDocuments)
      .values(
        segments.map((segment, ordinal) => ({
          id: workKey('doc'),
          sourceId,
          ordinal,
          locator: segment.locator,
          text: safeKnowledgeText(segment.text),
        })),
      )
      .onConflictDoNothing();
}
export async function uploadSource(db: Database, userId: string, input: unknown) {
  const value = sourceUploadSchema.parse(input);
  await requireProject(db, userId, value.projectId);
  const bytes = Buffer.from(value.base64, 'base64');
  if (bytes.toString('base64') !== value.base64) throw new MemoryError('SOURCE_INVALID');
  const segments = await parseDocument(value.kind, bytes);
  const hash = createHash('sha256')
    .update(value.kind)
    .update(value.name)
    .update(bytes)
    .digest('hex');
  return insertSource(
    db,
    userId,
    { projectId: value.projectId, requestId: value.requestId, name: value.name, kind: value.kind },
    hash,
    segments,
  );
}
export async function addUrlSource(
  db: Database,
  userId: string,
  input: unknown,
  network?: SafeNetworkDependencies,
) {
  const value = sourceUrlSchema.parse(input);
  await requireProject(db, userId, value.projectId);
  try {
    await resolvePublicUrl(value.url, network);
  } catch {
    throw new MemoryError('SOURCE_INVALID');
  }
  const hash = createHash('sha256').update(value.url).update(value.name).digest('hex');
  return insertSource(db, userId, { ...value, kind: 'url' }, hash, []);
}
export async function ingestSource(
  db: Database,
  id: string,
  signal: AbortSignal,
  network?: SafeNetworkDependencies,
) {
  const [source] = await db.orm.select().from(kbSources).where(eq(kbSources.id, id));
  if (!source) throw new MemoryError('SOURCE_NOT_FOUND');
  if (source.status === 'ready') return;
  if (source.kind === 'url') {
    const fetched = await fetchPublicText(source.url!, signal, {
      ...network,
      maxResponseBytes: 1_000_000,
    });
    if (fetched.status < 200 || fetched.status >= 300) throw new MemoryError('SOURCE_INVALID');
    const segments = await parseDocument(
      fetched.contentType.includes('html') ? 'html' : 'md',
      Buffer.from(fetched.text),
    );
    await db.orm.transaction((tx) => insertDocuments(tx, id, segments));
  }
  const documents = await db.orm
    .select()
    .from(kbDocuments)
    .where(eq(kbDocuments.sourceId, id))
    .orderBy(asc(kbDocuments.ordinal));
  const chunks = documents.flatMap((document) =>
    chunkText(document.text).map((text, part) => ({
      id: workKey('chk'),
      sourceId: id,
      documentId: document.id,
      projectId: source.projectId,
      text,
      locator: `${document.locator} · chunk ${part + 1}`,
      ordinal: 0,
    })),
  );
  if (!chunks.length || chunks.length > 1500) throw new MemoryError('SOURCE_INVALID');
  chunks.forEach((chunk, index) => {
    chunk.ordinal = index;
  });
  if (signal.aborted) throw new MemoryError('JOB_INTERRUPTED');
  await db.orm.transaction(async (tx) => {
    await tx.insert(kbChunks).values(chunks).onConflictDoNothing();
    await tx
      .update(kbSources)
      .set({ status: 'ready', errorCode: null })
      .where(eq(kbSources.id, id));
  });
}
export async function deleteSource(db: Database, userId: string, id: string) {
  return db.orm.transaction(async (tx) => {
    const rows = await tx
      .delete(kbSources)
      .where(and(eq(kbSources.id, id), eq(kbSources.userId, userId)))
      .returning({ id: kbSources.id });
    if (!rows.length) throw new MemoryError('SOURCE_NOT_FOUND');
    await tx
      .insert(auditLog)
      .values({ id: workKey('aud'), actorId: userId, action: 'kb.source.deleted', target: id });
    return { deleted: rows.length };
  });
}
export async function readChunk(db: Database, userId: string, id: string, projectId?: string) {
  const [row] = await db.orm
    .select({ chunk: kbChunks, source: kbSources })
    .from(kbChunks)
    .innerJoin(kbSources, eq(kbSources.id, kbChunks.sourceId))
    .where(
      and(
        eq(kbChunks.id, id),
        eq(kbSources.userId, userId),
        eq(kbSources.status, 'ready'),
        projectId ? eq(kbChunks.projectId, projectId) : undefined,
      ),
    );
  if (!row) throw new MemoryError('SOURCE_NOT_FOUND');
  return publicChunk(row.chunk, row.source);
}
export function publicChunk(
  chunk: typeof kbChunks.$inferSelect,
  source: typeof kbSources.$inferSelect,
) {
  return chunkSchema.parse({
    id: chunk.id,
    sourceId: chunk.sourceId,
    projectId: chunk.projectId,
    locator: chunk.locator,
    text: secretRedactor.redactText(chunk.text),
    ordinal: chunk.ordinal,
    sourceName: secretRedactor.redactText(source.name),
    sourceUrl: source.url === null ? null : secretRedactor.redactText(source.url),
    citation: `[kb:${chunk.id}]`,
  });
}
