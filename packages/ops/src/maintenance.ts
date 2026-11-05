import { setTimeout as delay } from 'node:timers/promises';
import { eq, sql } from 'drizzle-orm';
import { MAINTENANCE_LOCK, operationGate, operations, type Database } from '@sazuz/db';
import { operationIdSchema, OperationsError } from '@sazuz/core/operations';

export const OPERATION_LOCK = 72839112;
/** A separate leader prevents recovery from clearing an operation that is still draining. */
export async function exclusiveOperation<T>(
  db: Database,
  id: string,
  action: () => Promise<T>,
  keepGate: boolean | (() => boolean) = false,
): Promise<T> {
  operationIdSchema.parse(id);
  const client = await db.coordination.connect();
  let leader = false,
    exclusive = false,
    gate = false;
  try {
    leader =
      (
        await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
          OPERATION_LOCK,
        ])
      ).rows[0]?.locked ?? false;
    if (!leader) throw new OperationsError('OPS_BUSY');
    const result = await client.query(
      "UPDATE operation_gate SET operation_id=$1,updated_at=now() WHERE id='singleton' AND (operation_id IS NULL OR operation_id=$1)",
      [id],
    );
    if (result.rowCount !== 1) throw new OperationsError('OPS_BUSY');
    gate = true;
    const deadline = Date.now() + 30000;
    while (!exclusive && Date.now() < deadline) {
      exclusive =
        (
          await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
            MAINTENANCE_LOCK,
          ])
        ).rows[0]?.locked ?? false;
      if (!exclusive) await delay(100);
    }
    if (!exclusive) throw new OperationsError('OPS_BUSY');
    const active = await client.query<{ count: number }>(`SELECT (
      (SELECT count(*) FROM runs WHERE claim_key IS NOT NULL) +
      (SELECT count(*) FROM browser_sessions WHERE status IN ('opening','active'))
      )::integer AS count`);
    if (active.rows[0]?.count) throw new OperationsError('OPS_BUSY');
    return await action();
  } finally {
    try {
      if (gate && !(typeof keepGate === 'function' ? keepGate() : keepGate))
        await db.orm
          .update(operationGate)
          .set({ operationId: null, updatedAt: new Date() })
          .where(eq(operationGate.operationId, id));
      if (exclusive) await client.query('SELECT pg_advisory_unlock($1)', [MAINTENANCE_LOCK]);
      if (leader) await client.query('SELECT pg_advisory_unlock($1)', [OPERATION_LOCK]);
      client.release();
    } catch {
      client.release(true);
      db.logger.error({ code: 'OPS_RELEASE_FAILED' }, 'Operation cleanup requires recovery.');
    }
  }
}
export async function recoverOperations(db: Database) {
  const client = await db.coordination.connect();
  let leader = false;
  try {
    leader =
      (
        await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
          OPERATION_LOCK,
        ])
      ).rows[0]?.locked ?? false;
    if (!leader) return;
    // Reserved operations with no live leader never repeat automatically, even if a crash
    // happened before the durable maintenance gate was installed.
    await db.orm
      .update(operations)
      .set({ status: 'interrupted', code: 'OPS_INTERRUPTED', finishedAt: new Date() })
      .where(
        sql`${operations.kind}='backup' AND ${operations.status} IN ('queued','running') AND ${operations.createdAt}<now()-interval '5 minutes'`,
      );
    const [gate] = await db.orm.select().from(operationGate);
    if (!gate?.operationId) return;
    const [operation] = await db.orm
      .select()
      .from(operations)
      .where(eq(operations.id, gate.operationId));
    if (operation?.kind === 'update') return; // The host updater owns recovery and its external journal.
    if (operation && operation.status !== 'done')
      await db.orm
        .update(operations)
        .set({ status: 'interrupted', code: 'OPS_INTERRUPTED', finishedAt: new Date() })
        .where(eq(operations.id, operation.id));
    await db.orm
      .update(operationGate)
      .set({ operationId: null, updatedAt: new Date() })
      .where(eq(operationGate.id, 'singleton'));
    if (operation?.kind === 'restore')
      await db.orm.execute(sql`SELECT pg_notify('instance_restored',${operation.id})`);
  } finally {
    try {
      if (leader) await client.query('SELECT pg_advisory_unlock($1)', [OPERATION_LOCK]);
      client.release();
    } catch {
      client.release(true);
      db.logger.warn(
        { code: 'OPS_RECOVERY_LEASE_LOST' },
        'The operation recovery connection was closed.',
      );
    }
  }
}
