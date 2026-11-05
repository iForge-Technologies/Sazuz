import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  auditLog,
  costLedger,
  getControl,
  knowledgeJobs,
  missionContext,
  ownedProject,
  remainingSpend,
  runs,
  workKey,
  kbSources,
  embeddingGenerations,
  type Database,
} from '@sazuz/db';
import { knowledgeJobPayloadSchema, knowledgeJobSchema } from '@sazuz/core/memory';
import { missionLimitsSchema } from '@sazuz/core/missions';
import type { SettingsDocument } from '@sazuz/config/settings';
import type { GenerateRequest, GenerationUsageRecord } from '@sazuz/llm/contracts';
import type { ModelRouter } from '@sazuz/llm';
import type { ExecutionRequest } from '@sazuz/vault';
import { extractMemories } from './extraction.js';
import { MemoryError } from './errors.js';
import { buildIndex, syncIndexes } from './indexing.js';
import { ingestSource } from './sources.js';
import type { SafeNetworkDependencies } from '@sazuz/tools';

export type KnowledgeExecution = Pick<
  ExecutionRequest,
  'runId' | 'claimKey' | 'executionId' | 'scope'
>;
export type JobRow = typeof knowledgeJobs.$inferSelect;
export function publicJob(row: JobRow) {
  return knowledgeJobSchema.parse({
    id: row.id,
    kind: row.kind,
    projectId: row.projectId,
    runId: row.runId,
    status: row.status,
    step: row.step,
    costUsd: row.costUsd,
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
export async function listKnowledgeJobs(db: Database, userId: string) {
  return (
    await db.orm
      .select()
      .from(knowledgeJobs)
      .where(eq(knowledgeJobs.userId, userId))
      .orderBy(sql`${knowledgeJobs.createdAt} DESC`)
      .limit(100)
  ).map(publicJob);
}
export async function retryKnowledgeJob(db: Database, userId: string, id: string) {
  return db.orm.transaction(async (tx) => {
    const [job] = await tx
      .update(knowledgeJobs)
      .set({ status: 'queued', errorCode: null, updatedAt: new Date() })
      .where(
        and(
          eq(knowledgeJobs.id, id),
          eq(knowledgeJobs.userId, userId),
          inArray(knowledgeJobs.status, ['failed', 'blocked']),
        ),
      )
      .returning();
    if (!job) throw new MemoryError('JOB_CONFLICT');
    await tx
      .insert(auditLog)
      .values({ id: workKey('aud'), actorId: userId, action: 'knowledge.retry', target: id });
    return publicJob(job);
  });
}
export interface KnowledgeWorkerOptions {
  database: Database;
  workerId: string;
  getSettings(): SettingsDocument;
  signal?: AbortSignal;
  router(
    scope: KnowledgeExecution,
  ): Pick<ModelRouter, 'generate' | 'generateObject'> & Partial<Pick<ModelRouter, 'embed'>>;
  network?: SafeNetworkDependencies;
  ready?(scope: KnowledgeExecution, signal: AbortSignal): Promise<void>;
}
/** One bounded job under the same spending lock as missions; interrupted calls require a reviewed retry. */
export function createKnowledgeWorker(options: KnowledgeWorkerOptions) {
  const { database: db } = options;
  async function tick() {
    if (options.signal?.aborted || (await getControl(db)).paused) return;
    const lease = await db.pool.connect();
    let locked = false;
    let job: JobRow | undefined;
    let watch: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(60_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      locked =
        (await lease.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(72839102) AS locked'))
          .rows[0]?.locked ?? false;
      if (!locked) return;
      // Holding the shared lock proves that no other conforming worker is still executing these jobs.
      await db.orm
        .update(knowledgeJobs)
        .set({
          status: 'blocked',
          errorCode: 'JOB_INTERRUPTED',
          workerId: null,
          claimKey: null,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeJobs.status, 'running'));
      let [next] = await db.orm
        .select()
        .from(knowledgeJobs)
        .where(eq(knowledgeJobs.status, 'queued'))
        .orderBy(asc(knowledgeJobs.createdAt))
        .limit(1);
      if (!next) {
        await syncIndexes(db, options.getSettings());
        [next] = await db.orm
          .select()
          .from(knowledgeJobs)
          .where(eq(knowledgeJobs.status, 'queued'))
          .orderBy(asc(knowledgeJobs.createdAt))
          .limit(1);
      }
      if (!next) return;
      const [claimed] = await db.orm
        .update(knowledgeJobs)
        .set({
          status: 'running',
          workerId: options.workerId,
          claimKey: randomUUID(),
          updatedAt: new Date(),
        })
        .where(and(eq(knowledgeJobs.id, next.id), eq(knowledgeJobs.status, 'queued')))
        .returning();
      if (!claimed) return;
      job = claimed;
      const payload = knowledgeJobPayloadSchema.parse(claimed.payload);
      const initialCost = claimed.costUsd;
      let controlBusy = false;
      watch = setInterval(() => {
        if (controlBusy) return;
        controlBusy = true;
        void getControl(db)
          .then(
            (control) => {
              if (control.paused) controller.abort();
            },
            () => {
              controller.abort();
              db.logger.warn(
                { code: 'KNOWLEDGE_CONTROL_UNAVAILABLE' },
                'Background work paused because control state is unavailable.',
              );
            },
          )
          .finally(() => {
            controlBusy = false;
          });
      }, 200);
      watch.unref();
      const settings = options.getSettings();
      const project = job.projectId ? await ownedProject(db, job.userId, job.projectId) : undefined;
      if (job.projectId && !project) throw new MemoryError('JOB_NOT_FOUND');
      const run = job.runId ? await missionContext(db, job.runId) : undefined;
      const runLimits = run ? missionLimitsSchema.parse(run.run.limits) : undefined;
      if (run && runLimits && run.run.step >= runLimits.maxSteps)
        throw new MemoryError('JOB_BUDGET');
      const scope: KnowledgeExecution = {
        scope: 'knowledge',
        executionId: job.id,
        claimKey: job.claimKey,
        runId: null,
      };
      const remaining = async () =>
        Math.min(
          job!.maxCostUsd - job!.costUsd,
          run && runLimits
            ? runLimits.maxCostUsd - run.run.costUsd - (job!.costUsd - initialCost)
            : settings.budgets.value.perRunUsd,
          await remainingSpend(
            db,
            options.getSettings().budgets.value,
            project?.id,
            project?.budgetUsd,
          ),
        );
      if ((await remaining()) < 0 || job.step >= 200) throw new MemoryError('JOB_BUDGET');
      if (payload.kind !== 'ingest') await options.ready?.(scope, signal);
      const onUsage = async (record: GenerationUsageRecord) => {
        await db.orm.transaction(async (tx) => {
          await tx.insert(costLedger).values({
            id: workKey('cost'),
            projectId: job!.projectId,
            runId: job!.runId ?? job!.id,
            agentId: 'memory',
            providerId: record.providerId,
            modelId: record.modelId,
            inputTokens: record.usage.inputTokens,
            outputTokens: record.usage.outputTokens,
            cachedInputTokens: record.usage.cachedInputTokens,
            costUsd: record.costUsd,
            estimated: record.costEstimated,
            latencyMs: record.latencyMs,
            status: record.status,
          });
          await tx
            .update(knowledgeJobs)
            .set({
              costUsd: sql`${knowledgeJobs.costUsd}+${record.costUsd}`,
              updatedAt: new Date(),
            })
            .where(eq(knowledgeJobs.id, job!.id));
          if (job!.runId)
            await tx
              .update(runs)
              .set({ costUsd: sql`${runs.costUsd}+${record.costUsd}` })
              .where(eq(runs.id, job!.runId));
        });
        job!.costUsd += record.costUsd;
      };
      const request: Omit<GenerateRequest, 'messages'> = {
        role: 'fast',
        privateOnly: project?.privacy === 'private',
        remainingBudgetUsd: Math.max(0, await remaining()),
        signal,
        onUsage,
      };
      const router = options.router(scope);
      if (payload.kind === 'extract')
        await extractMemories({
          database: db,
          runId: payload.runId,
          autoAccept: settings.memory.value.autoAccept,
          generate: router.generateObject.bind(router),
          request,
        });
      else if (payload.kind === 'ingest')
        await ingestSource(db, payload.sourceId, signal, options.network);
      else
        await buildIndex(
          db,
          payload.generationId,
          () => options.getSettings(),
          async (target, texts, privateOnly) => {
            const embed = router.embed?.bind(router);
            if (!embed) throw new MemoryError('EMBEDDING_UNAVAILABLE');
            if (job!.step >= 199 || (await remaining()) < 0 || signal.aborted)
              throw new MemoryError('JOB_BUDGET');
            job!.step++;
            await db.orm
              .update(knowledgeJobs)
              .set({ step: job!.step, updatedAt: new Date() })
              .where(eq(knowledgeJobs.id, job!.id));
            return embed({
              providerId: target.providerId,
              modelId: target.modelId,
              texts,
              privateOnly,
              remainingBudgetUsd: Math.max(0, await remaining()),
              signal,
              onUsage,
            });
          },
          signal,
        );
      await db.orm.transaction(async (tx) => {
        await tx
          .update(knowledgeJobs)
          .set({
            status: 'completed',
            step: job!.step + 1,
            workerId: null,
            claimKey: null,
            updatedAt: new Date(),
          })
          .where(eq(knowledgeJobs.id, job!.id));
        if (job!.runId)
          await tx
            .update(runs)
            .set({ step: sql`${runs.step}+1` })
            .where(eq(runs.id, job!.runId));
      });
    } catch (error) {
      if (!job) throw error;
      const code =
        error instanceof MemoryError
          ? error.code
          : error instanceof Error && 'code' in error && /BUDGET|PRICE/.test(String(error.code))
            ? 'JOB_BUDGET'
            : signal.aborted
              ? 'JOB_INTERRUPTED'
              : 'JOB_FAILED';
      await db.orm
        .update(knowledgeJobs)
        .set({
          status: code === 'JOB_BUDGET' || code === 'JOB_INTERRUPTED' ? 'blocked' : 'failed',
          errorCode: code,
          workerId: null,
          claimKey: null,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeJobs.id, job.id));
      if (job.sourceId)
        await db.orm
          .update(kbSources)
          .set({ status: 'failed', errorCode: code })
          .where(eq(kbSources.id, job.sourceId));
      const payload = knowledgeJobPayloadSchema.safeParse(job.payload);
      if (payload.success && payload.data.kind === 'reindex')
        await db.orm
          .update(embeddingGenerations)
          .set({ status: 'failed' })
          .where(
            and(
              eq(embeddingGenerations.id, payload.data.generationId),
              sql`${embeddingGenerations.status} <> 'active'`,
            ),
          );
      db.logger.warn(
        { code, jobId: job.id },
        'Background work needs review; no automatic replay will occur.',
      );
    } finally {
      if (watch) clearInterval(watch);
      controller.abort();
      let reusable = false;
      try {
        if (locked) await lease.query('SELECT pg_advisory_unlock(72839102)');
        reusable = true;
      } finally {
        lease.release(!reusable);
      }
    }
  }
  return { tick };
}
