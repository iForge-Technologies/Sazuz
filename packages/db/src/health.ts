import { performance } from 'node:perf_hooks';
import { HEARTBEAT_TTL_MS, healthSchema, type Health, type WorkerHealth } from '@sazuz/core';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from './client.js';

const databaseTimestampSchema = z.union([z.date(), z.string().min(1)]).pipe(z.coerce.date());

export const heartbeatSnapshotSchema = z.strictObject({
  checkedAt: databaseTimestampSchema,
  vectorReady: z.boolean(),
  activeCount: z.number().int().nonnegative(),
  lastSeenAt: databaseTimestampSchema.nullable(),
});

export function snapshotToHealth(
  snapshot: z.infer<typeof heartbeatSnapshotSchema>,
  latencyMs: number,
): Health {
  const worker: WorkerHealth = snapshot.vectorReady
    ? {
        status:
          snapshot.activeCount > 0 ? 'ok' : snapshot.lastSeenAt === null ? 'missing' : 'stale',
        activeCount: snapshot.activeCount,
        lastSeenAt: snapshot.lastSeenAt?.toISOString() ?? null,
      }
    : { status: 'unavailable', activeCount: 0, lastSeenAt: null };
  return healthSchema.parse({
    status: snapshot.vectorReady && worker.status === 'ok' ? 'ok' : 'degraded',
    checkedAt: snapshot.checkedAt.toISOString(),
    services: {
      database: { status: snapshot.vectorReady ? 'ok' : 'error', latencyMs },
      worker,
    },
  });
}

export async function readHealth(database: Database): Promise<Health> {
  const startedAt = performance.now();
  try {
    const result = await database.orm.execute(sql`
      SELECT now() AS "checkedAt",
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS "vectorReady",
        (COUNT(*) FILTER (WHERE last_seen_at >= now() - ${HEARTBEAT_TTL_MS} * interval '1 millisecond'
          AND last_seen_at <= now()))::integer AS "activeCount",
        MAX(last_seen_at) AS "lastSeenAt"
      FROM worker_heartbeats
    `);
    const snapshot = heartbeatSnapshotSchema.parse(result.rows[0]);
    return snapshotToHealth(snapshot, Math.round(performance.now() - startedAt));
  } catch {
    database.logger.warn({ code: 'HEALTH_DB_UNAVAILABLE' }, 'Database readiness check failed.');
    return healthSchema.parse({
      status: 'degraded',
      checkedAt: new Date().toISOString(),
      services: {
        database: { status: 'error', latencyMs: Math.round(performance.now() - startedAt) },
        worker: { status: 'unavailable', activeCount: 0, lastSeenAt: null },
      },
    });
  }
}
