import { PgBoss } from 'pg-boss';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { queueOutbox, runs, enqueueRun, type Database } from '@sazuz/db';
import { workId } from '@sazuz/core/work';

const jobSchema = z.strictObject({ runId: workId });
export const MISSION_QUEUE = 'sazuz-mission';
export async function createMissionQueue(database: Database) {
  const boss = new PgBoss({
    schema: 'sazuz_jobs',
    db: { executeSql: (query, values) => database.pool.query(query, values) },
    schedule: false,
    reindex: false,
    monitorVacuum: false,
    superviseIntervalSeconds: 5,
    maintenanceIntervalSeconds: 60,
    registerInstance: false,
    openTelemetry: { enabled: false },
  });
  boss.on('error', () =>
    database.logger.error(
      { code: 'QUEUE_UNAVAILABLE' },
      'The durable queue is unavailable. Pending work remains in PostgreSQL.',
    ),
  );
  boss.on('warning', () =>
    database.logger.warn(
      { code: 'QUEUE_WARNING' },
      'The durable queue reported a maintenance warning.',
    ),
  );
  try {
    await boss.start();
    await boss.createQueue(MISSION_QUEUE, {
      retryLimit: 10,
      retryDelay: 1,
      retryBackoff: true,
      expireInSeconds: 86400,
      retentionSeconds: 86400,
    });
  } catch (error) {
    try {
      await boss.stop({ graceful: false });
    } catch {
      database.logger.error(
        { code: 'QUEUE_STARTUP_CLEANUP_FAILED' },
        'Queue startup resources could not be closed.',
      );
    }
    throw error;
  }
  let dispatching = false;
  async function dispatch() {
    if (dispatching) return;
    dispatching = true;
    try {
      const pending = await database.orm.select().from(queueOutbox).limit(50);
      for (const row of pending) {
        const job = await boss.send(MISSION_QUEUE, jobSchema.parse({ runId: row.runId }));
        if (!job) throw new Error('The durable queue did not accept the outbox entry.');
        await database.orm
          .delete(queueOutbox)
          .where(and(eq(queueOutbox.runId, row.runId), eq(queueOutbox.generation, row.generation)));
      }
    } finally {
      dispatching = false;
    }
  }
  async function recover() {
    const pending = await database.orm
      .select({ id: runs.id })
      .from(runs)
      .where(
        sql`${runs.status} IN ('queued','running','waiting_tasks') OR ${runs.claimKey} IS NOT NULL`,
      )
      .limit(100);
    for (const row of pending) {
      const lease = await database.pool.connect();
      let owned = false;
      try {
        owned =
          (
            await lease.query<{ locked: boolean }>(
              'SELECT pg_try_advisory_lock(hashtextextended($1, 3)) AS locked',
              [row.id],
            )
          ).rows[0]?.locked ?? false;
        if (!owned) continue;
        await database.orm.transaction(async (tx) => {
          await tx
            .update(runs)
            .set({ claimKey: null, workerId: null, claimedAt: null })
            .where(eq(runs.id, row.id));
          const current = await tx
            .update(runs)
            .set({
              status: 'queued',
              claimKey: null,
              workerId: null,
              claimedAt: null,
              updatedAt: new Date(),
            })
            .where(
              and(eq(runs.id, row.id), sql`${runs.status} IN ('queued','running','waiting_tasks')`),
            )
            .returning();
          if (current.length) await enqueueRun(tx, row.id);
        });
      } finally {
        let reusable = false;
        try {
          if (owned)
            await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,3))', [row.id]);
          reusable = true;
        } finally {
          lease.release(!reusable);
        }
      }
    }
  }
  return {
    boss,
    dispatch,
    recover,
    async work(execute: (runId: string) => Promise<void>) {
      await boss.work<{ runId: string }, void>(
        MISSION_QUEUE,
        { pollingIntervalSeconds: 0.5, localConcurrency: 4, batchSize: 1 },
        async (jobs) => {
          for (const job of jobs) {
            const payload = jobSchema.safeParse(job.data);
            if (!payload.success) {
              database.logger.error(
                { code: 'QUEUE_INVALID_PAYLOAD' },
                'An invalid job was rejected.',
              );
              continue;
            }
            await execute(payload.data.runId);
          }
        },
      );
    },
    async close() {
      await boss.stop({ graceful: true, timeout: 5000 });
    },
  };
}
export type MissionQueue = Awaited<ReturnType<typeof createMissionQueue>>;
