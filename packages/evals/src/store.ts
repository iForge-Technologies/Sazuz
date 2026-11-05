import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  auditLog,
  costLedger,
  evalResults,
  evalRuns,
  projects,
  valueHash,
  workKey,
  type Database,
} from '@sazuz/db';
import {
  EvalError,
  evalCaseResultSchema,
  evalPresetSchema,
  evalReportSchema,
  evalRequestSchema,
  evalRunSchema,
  evalSuiteSchema,
} from '@sazuz/core/evals';
import type { SettingsDocument } from '@sazuz/config/settings';
import { secretRedactor } from '@sazuz/vault';
import { selectSuites, suiteSummary } from './loader.js';
import { evalRecordSchema, type EvalPersistence } from './journal.js';

export const evalLimitsSchema = z.strictObject({
  maxCostUsd: z.number().finite().min(0).max(10000),
  maxSteps: z.number().int().min(1).max(16),
  maxWallTimeSeconds: z.number().int().min(1).max(600),
});
export const storedSuites = (row: typeof evalRuns.$inferSelect) =>
  z.array(evalSuiteSchema).min(1).max(8).parse(row.suites);
export const publicEvaluation = (row: typeof evalRuns.$inferSelect) =>
  evalRunSchema.parse(
    secretRedactor.redact({
      id: row.id,
      projectId: row.projectId,
      mode: row.mode,
      judge: row.judge,
      suites: storedSuites(row).map(suiteSummary),
      presets: row.presets,
      status: row.status,
      totalCases: row.totalCases,
      completedCases: row.completedCases,
      passedCases: row.passedCases,
      costUsd: row.costUsd,
      judgeCostUsd: row.judgeCostUsd,
      maxCostUsd: evalLimitsSchema.parse(row.limits).maxCostUsd,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    }),
  );
export async function startEvaluation(
  db: Database,
  userId: string,
  input: unknown,
  settings: SettingsDocument,
) {
  const body = evalRequestSchema.parse(input);
  const requestHash = valueHash(body);
  const row = await db.orm.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'eval:' + userId + ':' + body.requestId}))`,
    );
    const [existing] = await tx
      .select()
      .from(evalRuns)
      .where(and(eq(evalRuns.userId, userId), eq(evalRuns.requestId, body.requestId)));
    if (existing) {
      if (existing.requestHash !== requestHash) throw new EvalError('EVAL_CONFLICT');
      return existing;
    }
    const [project] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, body.projectId), eq(projects.userId, userId)));
    if (!project) throw new EvalError('EVAL_NOT_FOUND');
    const suites = selectSuites(body.suites);
    if (
      suites.some((suite) => body.presets.some((preset) => !suite.model_presets.includes(preset)))
    )
      throw new EvalError('EVAL_INVALID');
    const cases = suites.flatMap((suite) =>
      body.presets.flatMap((preset) =>
        suite.cases.map((item) => ({ suite: suite.suite, preset, caseId: item.id })),
      ),
    );
    if (!cases.length || cases.length > 128 || JSON.stringify(suites).length > 1_000_000)
      throw new EvalError('EVAL_LIMIT');
    const id = workKey('evl');
    const limits = evalLimitsSchema.parse({
      maxCostUsd: body.mode === 'fixture' ? 0 : settings.budgets.value.perRunUsd,
      maxSteps: Math.min(16, settings.budgets.value.maxSteps),
      maxWallTimeSeconds: Math.min(600, settings.budgets.value.maxWallTimeSeconds),
    });
    const [created] = await tx
      .insert(evalRuns)
      .values({
        id,
        userId,
        projectId: project.id,
        requestId: body.requestId,
        requestHash,
        mode: body.mode,
        judge: body.judge,
        suites,
        presets: body.presets,
        limits,
        privateOnly: project.privacy === 'private',
        totalCases: cases.length,
      })
      .returning();
    if (!created) throw new EvalError('EVAL_INVALID');
    await tx
      .insert(evalResults)
      .values(
        cases.map((item, ordinal) => ({ id: workKey('evc'), evalRunId: id, ordinal, ...item })),
      );
    await tx
      .insert(auditLog)
      .values({ id: workKey('aud'), actorId: userId, action: 'eval.created', target: id });
    return created;
  });
  return publicEvaluation(row);
}
export async function listEvaluations(db: Database, userId: string) {
  return (
    await db.orm
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.userId, userId))
      .orderBy(desc(evalRuns.createdAt))
      .limit(50)
  ).map(publicEvaluation);
}
export async function evaluationReport(db: Database, userId: string, id: string) {
  const [row] = await db.orm
    .select()
    .from(evalRuns)
    .where(and(eq(evalRuns.userId, userId), eq(evalRuns.id, id)));
  if (!row) throw new EvalError('EVAL_NOT_FOUND');
  const results = await db.orm
    .select({ result: evalResults.result })
    .from(evalResults)
    .where(and(eq(evalResults.evalRunId, id), sql`${evalResults.result} IS NOT NULL`))
    .orderBy(asc(evalResults.ordinal));
  return evalReportSchema.parse(
    secretRedactor.redact({
      ...publicEvaluation(row),
      results: results.map((item) => evalCaseResultSchema.parse(item.result)),
    }),
  );
}
export function databasePersistence(
  db: Database,
  run: typeof evalRuns.$inferSelect,
  item: typeof evalResults.$inferSelect,
): EvalPersistence {
  return {
    async load() {
      const [row] = await db.orm
        .select()
        .from(evalResults)
        .where(and(eq(evalResults.id, item.id), eq(evalResults.evalRunId, run.id)));
      if (!row) throw new EvalError('EVAL_NOT_FOUND');
      return row.checkpoint
        ? evalRecordSchema.parse({ checkpoint: row.checkpoint, journal: row.journal })
        : null;
    },
    async save(checkpoint, journal) {
      const record = evalRecordSchema.parse(secretRedactor.redact({ checkpoint, journal }));
      if (JSON.stringify(record).length > 3_000_000) throw new EvalError('EVAL_LIMIT');
      await db.orm.transaction(async (tx) => {
        const [owned] = await tx
          .select({ id: evalResults.id })
          .from(evalResults)
          .where(and(eq(evalResults.id, item.id), eq(evalResults.evalRunId, run.id)))
          .for('update');
        if (!owned) throw new EvalError('EVAL_NOT_FOUND');
        let cost = 0,
          judgeCost = 0;
        for (const usage of record.journal.charges) {
          const inserted = await tx
            .insert(costLedger)
            .values({
              id: usage.id,
              projectId: run.projectId,
              runId: run.id,
              agentId: usage.kind === 'judge' ? 'eval-judge' : 'eval:' + item.suite,
              providerId: usage.providerId,
              modelId: usage.modelId,
              inputTokens: usage.usage.inputTokens,
              outputTokens: usage.usage.outputTokens,
              cachedInputTokens: usage.usage.cachedInputTokens,
              costUsd: usage.costUsd,
              estimated: usage.costEstimated,
              latencyMs: usage.latencyMs,
              status: usage.status,
            })
            .onConflictDoNothing()
            .returning({ id: costLedger.id });
          if (inserted.length) {
            cost += usage.costUsd;
            if (usage.kind === 'judge') judgeCost += usage.costUsd;
          }
        }
        await tx
          .update(evalResults)
          .set({
            checkpoint: record.checkpoint,
            journal: record.journal,
            status: 'running',
            updatedAt: new Date(),
          })
          .where(eq(evalResults.id, item.id));
        if (cost || judgeCost)
          await tx
            .update(evalRuns)
            .set({
              costUsd: sql`${evalRuns.costUsd} + ${cost}`,
              judgeCostUsd: sql`${evalRuns.judgeCostUsd} + ${judgeCost}`,
            })
            .where(eq(evalRuns.id, run.id));
      });
    },
  };
}
export async function finishCase(
  db: Database,
  item: typeof evalResults.$inferSelect,
  input: unknown,
  uncertain: boolean,
) {
  const result = evalCaseResultSchema.parse(secretRedactor.redact(input));
  await db.orm.transaction(async (tx) => {
    const changed = await tx
      .update(evalResults)
      .set({ result, status: uncertain ? 'uncertain' : 'done', updatedAt: new Date() })
      .where(and(eq(evalResults.id, item.id), sql`${evalResults.result} IS NULL`))
      .returning({ id: evalResults.id });
    if (changed.length)
      await tx
        .update(evalRuns)
        .set({
          completedCases: sql`${evalRuns.completedCases} + 1`,
          passedCases: sql`${evalRuns.passedCases} + ${result.passed ? 1 : 0}`,
        })
        .where(eq(evalRuns.id, item.evalRunId));
  });
}
export const presetForCase = (item: typeof evalResults.$inferSelect) =>
  evalPresetSchema.parse(item.preset);
