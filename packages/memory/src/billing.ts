import { eq, sql } from 'drizzle-orm';
import {
  costLedger,
  getControl,
  missionContext,
  missionAllowance,
  remainingSpend,
  runs,
  workKey,
  type Database,
} from '@sazuz/db';
import type { SettingsDocument } from '@sazuz/config/settings';
import type { ModelRouter } from '@sazuz/llm';
import { missionLimitsSchema } from '@sazuz/core/missions';
import type { EmbedBatch } from './indexing.js';
import { MemoryError } from './errors.js';
import { requireProject } from './store.js';

/** API queries acquire the spending lock; tool queries already execute under their run's lock. */
export function billedEmbeddings(options: {
  database: Database;
  userId: string;
  projectId: string;
  getSettings: () => SettingsDocument;
  router: Pick<ModelRouter, 'embed'>;
  signal?: AbortSignal;
  runId?: string;
  agentId?: string;
}): EmbedBatch {
  return async (target, texts, privateOnly) => {
    const { database: db } = options;
    const project = await requireProject(db, options.userId, options.projectId);
    const lease = options.runId ? undefined : await db.pool.connect();
    let locked = false;
    try {
      if (lease) {
        locked =
          (
            await lease.query<{ locked: boolean }>(
              'SELECT pg_try_advisory_lock(72839102) AS locked',
            )
          ).rows[0]?.locked ?? false;
        if (!locked) throw new MemoryError('JOB_BUDGET');
      }
      if ((await getControl(db)).paused) throw new MemoryError('JOB_INTERRUPTED');
      const settings = options.getSettings();
      const provider = settings.providers.value.items.find(
        (value) => value.id === target.providerId && value.enabled,
      );
      if (!provider || provider.baseUrl !== target.providerUrl)
        throw new MemoryError('EMBEDDING_UNAVAILABLE');
      const run = options.runId ? await missionContext(db, options.runId) : undefined;
      if (options.runId && (!run || run.project.id !== project.id || run.run.status !== 'running'))
        throw new MemoryError('JOB_NOT_FOUND');
      const runBudget = run
        ? missionLimitsSchema.parse(run.run.limits).maxCostUsd - run.run.costUsd
        : Math.min(0.05, settings.budgets.value.perRunUsd);
      const remaining = Math.min(
        runBudget,
        run ? (await missionAllowance(db, run.mission.id)).usd : Number.POSITIVE_INFINITY,
        await remainingSpend(db, settings.budgets.value, project.id, project.budgetUsd),
      );
      if (remaining < 0) throw new MemoryError('JOB_BUDGET');
      return await options.router.embed({
        providerId: target.providerId,
        modelId: target.modelId,
        texts,
        privateOnly: privateOnly || project.privacy === 'private',
        remainingBudgetUsd: remaining,
        signal: options.signal ?? AbortSignal.timeout(10000),
        onUsage: async (usage) => {
          await db.orm.transaction(async (tx) => {
            await tx.insert(costLedger).values({
              id: workKey('cost'),
              projectId: project.id,
              runId: options.runId ?? null,
              agentId: options.agentId ?? 'knowledge-search',
              providerId: usage.providerId,
              modelId: usage.modelId,
              inputTokens: usage.usage.inputTokens,
              outputTokens: 0,
              cachedInputTokens: 0,
              costUsd: usage.costUsd,
              estimated: usage.costEstimated,
              latencyMs: usage.latencyMs,
              status: usage.status,
            });
            if (options.runId)
              await tx
                .update(runs)
                .set({ costUsd: sql`${runs.costUsd}+${usage.costUsd}` })
                .where(eq(runs.id, options.runId));
          });
        },
      });
    } finally {
      if (lease) {
        let reusable = false;
        try {
          if (locked) await lease.query('SELECT pg_advisory_unlock(72839102)');
          reusable = true;
        } finally {
          lease.release(!reusable);
        }
      }
    }
  };
}
