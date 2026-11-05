import type { Database } from './client.js';
import { OperationsError } from '@sazuz/core/operations';

export const MAINTENANCE_LOCK = 72839111;
/** Session leases cover the full request/job, including its asynchronous effects. */
export async function acquireActivity(db: Database): Promise<(() => Promise<void>) | null> {
  const client = await db.coordination.connect();
  try {
    const locked =
      (
        await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock_shared($1) AS locked',
          [MAINTENANCE_LOCK],
        )
      ).rows[0]?.locked ?? false;
    if (locked) {
      const gate = await client.query<{ operation_id: string | null }>(
        "SELECT operation_id FROM operation_gate WHERE id='singleton'",
      );
      if (!gate.rows[0]?.operation_id) {
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          try {
            await client.query('SELECT pg_advisory_unlock_shared($1)', [MAINTENANCE_LOCK]);
            client.release();
          } catch {
            client.release(true);
            db.logger.warn(
              { code: 'OPS_LEASE_LOST' },
              'A maintenance lease connection was closed.',
            );
          }
        };
      }
      await client.query('SELECT pg_advisory_unlock_shared($1)', [MAINTENANCE_LOCK]);
    }
    client.release();
    return null;
  } catch {
    client.release(true);
    throw new OperationsError('OPS_DATABASE');
  }
}
export async function withActivity<T>(
  db: Database,
  action: () => Promise<T>,
): Promise<T | undefined> {
  const release = await acquireActivity(db);
  if (!release) return undefined;
  try {
    return await action();
  } finally {
    await release();
  }
}
