import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  auditLog,
  memories,
  memoryReceipts,
  ownedProject,
  workKey,
  type Database,
  type Transaction,
} from '@sazuz/db';
import {
  forgetMemorySchema,
  memoryInputSchema,
  memoryQuerySchema,
  memorySchema,
  memorySearchSchema,
  memoryUpdateSchema,
  type Memory,
} from '@sazuz/core/memory';
import { secretRedactor } from '@sazuz/vault';
import { MemoryError } from './errors.js';

export function safeKnowledgeText(value: string): string {
  if (secretRedactor.redactText(value) !== value) throw new MemoryError('MEMORY_SECRET');
  return value;
}
export function publicMemory(row: typeof memories.$inferSelect): Memory {
  return memorySchema.parse({
    id: row.id,
    scope: row.scope,
    projectId: row.projectId,
    agentId: row.agentId,
    kind: row.kind,
    content: secretRedactor.redactText(row.content),
    importance: row.importance,
    status: row.status,
    sensitivity: row.sensitivity,
    sourceRunId: row.sourceRunId,
    sourceMessageId: row.sourceMessageId,
    sourceQuote: row.sourceQuote === null ? null : secretRedactor.redactText(row.sourceQuote),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
export async function requireProject(db: Database, userId: string, projectId: string) {
  const project = await ownedProject(db, userId, projectId);
  if (!project) throw new MemoryError('MEMORY_NOT_FOUND');
  return project;
}
export async function listMemories(db: Database, userId: string, input: unknown = {}) {
  const query = memoryQuerySchema.parse(input);
  if (query.projectId) await requireProject(db, userId, query.projectId);
  return (
    await db.orm
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, userId),
          query.projectId
            ? or(eq(memories.projectId, query.projectId), isNull(memories.projectId))
            : undefined,
          query.status ? eq(memories.status, query.status) : undefined,
        ),
      )
      .orderBy(desc(memories.updatedAt), desc(memories.id))
      .limit(500)
  ).map(publicMemory);
}
export async function createMemory(db: Database, userId: string, input: unknown) {
  const result = memoryInputSchema.safeParse(input);
  if (!result.success) throw new MemoryError('MEMORY_INVALID');
  const value = result.data;
  safeKnowledgeText(value.content);
  if (value.projectId) await requireProject(db, userId, value.projectId);
  return db.orm.transaction(async (tx) => {
    const [row] = await tx
      .insert(memories)
      .values({
        id: workKey('mem'),
        userId,
        ...value,
        status: 'accepted',
      })
      .returning();
    await audit(tx, userId, 'memory.created', row!.id);
    return publicMemory(row!);
  });
}
export async function updateMemory(db: Database, userId: string, id: string, input: unknown) {
  const value = memoryUpdateSchema.parse(input);
  safeKnowledgeText(value.content);
  return db.orm.transaction(async (tx) => {
    const [row] = await tx
      .update(memories)
      .set({
        ...value,
        version: value.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(eq(memories.id, id), eq(memories.userId, userId), eq(memories.version, value.version)),
      )
      .returning();
    if (!row) throw new MemoryError('MEMORY_CONFLICT');
    await audit(tx, userId, `memory.${value.status}`, id);
    return publicMemory(row);
  });
}
export async function deleteMemory(db: Database, userId: string, id: string, version: number) {
  return db.orm.transaction(async (tx) => {
    const deleted = await tx
      .delete(memories)
      .where(and(eq(memories.id, id), eq(memories.userId, userId), eq(memories.version, version)))
      .returning({ id: memories.id });
    if (!deleted.length) throw new MemoryError('MEMORY_CONFLICT');
    await audit(tx, userId, 'memory.deleted', id);
    return { deleted: deleted.length };
  });
}
export async function forgetMemories(db: Database, userId: string, input: unknown) {
  const value = forgetMemorySchema.parse(input);
  if (value.projectId) await requireProject(db, userId, value.projectId);
  return db.orm.transaction(async (tx) => {
    const deleted = await tx
      .delete(memories)
      .where(
        and(
          eq(memories.userId, userId),
          value.projectId ? eq(memories.projectId, value.projectId) : isNull(memories.projectId),
          sql`strpos(lower(${memories.content}), lower(${value.text})) > 0`,
        ),
      )
      .returning({ id: memories.id });
    // Never copy the forgotten text to an audit event.
    await audit(tx, userId, 'memory.forgotten', value.projectId ?? 'global');
    return { deleted: deleted.length };
  });
}
export function withinTokenBudget<T extends { content: string }>(rows: T[], budget: number): T[] {
  let remaining = budget;
  return rows.filter((row) => {
    const tokens = Math.ceil(Buffer.byteLength(JSON.stringify(row), 'utf8') / 3);
    if (tokens > remaining) return false;
    remaining -= tokens;
    return true;
  });
}
export async function searchMemories(
  db: Database,
  userId: string,
  input: unknown,
): Promise<Memory[]> {
  const query = memorySearchSchema.parse(input);
  await requireProject(db, userId, query.projectId);
  const rows = await db.orm
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        eq(memories.status, 'accepted'),
        or(isNull(memories.projectId), eq(memories.projectId, query.projectId)),
        or(isNull(memories.agentId), eq(memories.agentId, query.agentId)),
        // Preferences apply even when the next question has no words in common.
        or(
          sql`${query.query} = ''`,
          eq(memories.kind, 'preference'),
          sql`to_tsvector('simple', ${memories.content}) @@ plainto_tsquery('simple', ${query.query})`,
        ),
      ),
    )
    .orderBy(
      desc(
        sql`ts_rank(to_tsvector('simple', ${memories.content}), plainto_tsquery('simple', ${query.query})) + ${memories.importance} * 0.05 + 0.02 / (1 + extract(epoch FROM (now()-${memories.updatedAt}))/86400)`,
      ),
      desc(memories.id),
    )
    .limit(40);
  return withinTokenBudget(rows.map(publicMemory), query.tokenBudget);
}
export function receiptKey(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
export async function proposalReceipt(db: Database, userId: string, key: string) {
  const [row] = await db.orm
    .select()
    .from(memoryReceipts)
    .where(and(eq(memoryReceipts.key, receiptKey(key)), eq(memoryReceipts.userId, userId)));
  return row ? { id: row.memoryId } : null;
}
export async function insertProposal(
  tx: Transaction,
  value: Omit<typeof memories.$inferInsert, 'id'>,
  key: string,
) {
  const id = workKey('mem');
  const receipt = await tx
    .insert(memoryReceipts)
    .values({ key: receiptKey(key), userId: value.userId, memoryId: id })
    .onConflictDoNothing()
    .returning();
  if (!receipt.length) {
    const [prior] = await tx
      .select()
      .from(memoryReceipts)
      .where(eq(memoryReceipts.key, receiptKey(key)));
    if (prior?.userId !== value.userId) throw new MemoryError('MEMORY_CONFLICT');
    return { id: prior.memoryId };
  }
  safeKnowledgeText(value.content);
  await tx.insert(memories).values({ ...value, id });
  await audit(tx, value.userId, 'memory.proposed', id);
  return { id };
}
async function audit(tx: Transaction, actorId: string, action: string, target: string) {
  await tx.insert(auditLog).values({ id: workKey('aud'), actorId, action, target });
}
