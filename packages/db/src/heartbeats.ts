import { HEARTBEAT_TTL_MS, SazuzError, workerIdSchema } from '@sazuz/core';
import { and, eq, gte, lte, lt, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { workerHeartbeats } from './schema.js';

function validateWorkerId(id: string): string {
  const parsed = workerIdSchema.safeParse(id);
  if (!parsed.success) throw new SazuzError('WORKER_ID_INVALID', 'Worker identifier is invalid.');
  return parsed.data;
}

export async function recordHeartbeat(database: Database, workerId: string): Promise<void> {
  const id = validateWorkerId(workerId);
  try {
    await database.orm
      .insert(workerHeartbeats)
      .values({ id })
      .onConflictDoUpdate({
        target: workerHeartbeats.id,
        set: { lastSeenAt: sql`now()` },
      });
    await database.orm
      .delete(workerHeartbeats)
      .where(lt(workerHeartbeats.lastSeenAt, sql`now() - interval '1 day'`));
  } catch {
    throw new SazuzError('HEARTBEAT_FAILED', 'Worker could not update its heartbeat.');
  }
}

export async function removeHeartbeat(database: Database, workerId: string): Promise<void> {
  const id = validateWorkerId(workerId);
  try {
    await database.orm.delete(workerHeartbeats).where(eq(workerHeartbeats.id, id));
  } catch {
    throw new SazuzError('HEARTBEAT_REMOVE_FAILED', 'Worker could not remove its heartbeat.');
  }
}

export async function isWorkerHealthy(database: Database, workerId: string): Promise<boolean> {
  const id = validateWorkerId(workerId);
  try {
    const rows = await database.orm
      .select({ id: workerHeartbeats.id })
      .from(workerHeartbeats)
      .where(
        and(
          eq(workerHeartbeats.id, id),
          gte(
            workerHeartbeats.lastSeenAt,
            sql`now() - ${HEARTBEAT_TTL_MS} * interval '1 millisecond'`,
          ),
          lte(workerHeartbeats.lastSeenAt, sql`now()`),
        ),
      )
      .limit(1);
    return rows.length === 1;
  } catch {
    database.logger.warn(
      { code: 'WORKER_HEALTH_UNAVAILABLE' },
      'Worker health check could not reach the database.',
    );
    return false;
  }
}
