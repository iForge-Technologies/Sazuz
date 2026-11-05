import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SettingsDocument } from '@sazuz/config/settings';
import { runs, providerBuckets, type Database } from '@sazuz/db';

/** Claims, rather than worker-local promises, admit execution across all worker processes. */
export async function claimRun(
  db: Database,
  input: {
    runId: string;
    version: number;
    workerId: string;
    claimKey: string;
    agentId: string;
    userId: string;
    globalMax: number;
    agentMax: number;
  },
) {
  return db.orm.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(72839106)`);
    const counts = await tx.execute<{ total: number; agent: number }>(
      sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE r.agent_id=${input.agentId} AND p.user_id=${input.userId})::int AS agent FROM runs r JOIN missions m ON m.id=r.mission_id JOIN projects p ON p.id=m.project_id WHERE r.claim_key IS NOT NULL`,
    );
    if (
      (counts.rows[0]?.total ?? 0) >= input.globalMax ||
      (counts.rows[0]?.agent ?? 0) >= input.agentMax
    )
      return false;
    const acquired = await tx
      .update(runs)
      .set({
        status: 'running',
        workerId: input.workerId,
        claimKey: input.claimKey,
        claimedAt: new Date(),
        updatedAt: new Date(),
        version: sql`${runs.version}+1`,
      })
      .where(
        and(
          eq(runs.id, input.runId),
          eq(runs.version, input.version),
          sql`${runs.status} IN ('queued','running')`,
        ),
      )
      .returning({ id: runs.id });
    return acquired.length > 0;
  });
}
export function createProviderAdmission(db: Database, getSettings: () => SettingsDocument) {
  return async (providerId: string) => {
    const configured = getSettings().models.value.providerRateLimits.find(
      (value) => value.providerId === providerId,
    );
    const rate = configured?.requestsPerMinute ?? 60,
      burst = configured?.burst ?? 10;
    return db.orm.transaction(async (tx) => {
      await tx.insert(providerBuckets).values({ providerId, tokens: burst }).onConflictDoNothing();
      const [bucket] = await tx
        .select()
        .from(providerBuckets)
        .where(eq(providerBuckets.providerId, providerId))
        .for('update');
      const clock = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
      const now = z.coerce.date().parse(clock.rows[0]?.now);
      const available = Math.min(
        burst,
        bucket!.tokens + (Math.max(0, now.getTime() - bucket!.updatedAt.getTime()) / 60000) * rate,
      );
      await tx
        .update(providerBuckets)
        .set({ tokens: available >= 1 ? available - 1 : available, updatedAt: now })
        .where(eq(providerBuckets.providerId, providerId));
      return available >= 1;
    });
  };
}
