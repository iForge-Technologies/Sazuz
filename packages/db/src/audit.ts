import { and, asc, desc, eq, gt, lte } from 'drizzle-orm';
import { auditExportSchema, auditPageSchema, auditPayloadSchema } from '@sazuz/core/audit';
import { auditGenesis } from '@sazuz/core/audit-verify';
import type { Database } from './client.js';
import { auditChainState, auditLog } from './schema.js';

function entry(row: typeof auditLog.$inferSelect) {
  const payload = auditPayloadSchema.parse(JSON.parse(row.canonical));
  if (
    payload[0] !== row.id ||
    payload[1] !== row.actorId ||
    payload[2] !== row.action ||
    payload[3] !== row.target ||
    new Date(payload[4]).getTime() !== row.createdAt.getTime()
  )
    throw new Error('Audit row integrity failed.');
  return {
    sequence: row.sequence,
    previousHash: row.previousHash,
    hash: row.hash,
    canonical: row.canonical,
    payload,
  };
}
export async function readAudit(
  database: Database,
  input: { before?: number | undefined; action?: string | undefined; limit: number },
) {
  const [head] = await database.orm.select().from(auditChainState).limit(1);
  const rows = await database.orm
    .select()
    .from(auditLog)
    .where(
      and(
        input.before ? lte(auditLog.sequence, input.before - 1) : undefined,
        input.action ? eq(auditLog.action, input.action) : undefined,
      ),
    )
    .orderBy(desc(auditLog.sequence))
    .limit(input.limit);
  return auditPageSchema.parse({
    entries: rows.map(entry),
    head: head ? { sequence: head.sequence, hash: head.hash } : auditGenesis,
  });
}
export async function exportAudit(
  database: Database,
  after: number,
  limit: number,
  through?: number,
) {
  return database.orm.transaction(
    async (tx) => {
      const [tip] = await tx.select().from(auditChainState).limit(1);
      const headSequence = through ?? tip?.sequence ?? 0;
      const [headRow] = headSequence
        ? await tx.select().from(auditLog).where(eq(auditLog.sequence, headSequence))
        : [];
      const [startRow] = after
        ? await tx.select().from(auditLog).where(eq(auditLog.sequence, after))
        : [];
      if ((after && !startRow) || (headSequence && !headRow) || after > headSequence)
        throw new Error('Audit export range is unavailable.');
      const rows = await tx
        .select()
        .from(auditLog)
        .where(and(gt(auditLog.sequence, after), lte(auditLog.sequence, headSequence)))
        .orderBy(asc(auditLog.sequence))
        .limit(limit);
      return auditExportSchema.parse({
        format: 'sazuz-audit-v1',
        start: startRow ? { sequence: startRow.sequence, hash: startRow.hash } : auditGenesis,
        head: headRow ? { sequence: headRow.sequence, hash: headRow.hash } : auditGenesis,
        entries: rows.map(entry),
        complete: (rows.at(-1)?.sequence ?? after) === headSequence,
      });
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
