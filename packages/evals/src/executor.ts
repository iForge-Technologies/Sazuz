import { setTimeout as delay } from 'node:timers/promises';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  evalResults,
  evalRuns,
  getControl,
  projects,
  readSettings,
  remainingSpend,
  type Database,
} from '@sazuz/db';
import { EvalError } from '@sazuz/core/evals';
import type { SettingsDocument } from '@sazuz/config/settings';
import type { GenerateRequest, GenerateResult } from '@sazuz/llm/contracts';
import { RunSuspension } from '@sazuz/runtime';
import {
  databasePersistence,
  evalLimitsSchema,
  evaluationReport,
  finishCase,
  presetForCase,
  storedSuites,
} from './store.js';
import { evaluateCase } from './runner.js';
import { suiteHash } from './loader.js';

export interface EvalExecutorOptions {
  database: Database;
  getSettings(): SettingsDocument;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  signal?: AbortSignal;
}

/** Uses the same workspace spending lock as durable runs and auxiliary inference. */
async function admittedGeneration(
  options: EvalExecutorOptions,
  runId: string,
  caseId: string,
  request: GenerateRequest,
) {
  const db = options.database;
  const lease = await db.pool.connect();
  let locked = false;
  const waitUntil = Date.now() + 5000;
  try {
    while (!locked) {
      locked =
        (await lease.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(72839102) AS locked'))
          .rows[0]?.locked ?? false;
      if (!locked) {
        if (Date.now() >= waitUntil || request.signal?.aborted) throw new EvalError('EVAL_LIMIT');
        await delay(50, undefined, request.signal ? { signal: request.signal } : {});
      }
    }
    const [row] = await db.orm.select().from(evalRuns).where(eq(evalRuns.id, runId));
    if (!row || row.status !== 'running' || !row.startedAt) throw new EvalError('EVAL_LIMIT');
    const [project] = await db.orm
      .select()
      .from(projects)
      .where(and(eq(projects.id, row.projectId), eq(projects.userId, row.userId)));
    if (!project) throw new EvalError('EVAL_NOT_FOUND');
    const [entry] = await db.orm
      .select()
      .from(evalResults)
      .where(and(eq(evalResults.id, caseId), eq(evalResults.evalRunId, row.id)));
    if (!entry) throw new EvalError('EVAL_NOT_FOUND');
    const record = await databasePersistence(db, row, entry).load();
    const settings = await readSettings(db);
    const limits = evalLimitsSchema.parse(row.limits);
    const remainingMs =
      row.startedAt.getTime() +
      Math.min(limits.maxWallTimeSeconds, settings.budgets.value.maxWallTimeSeconds) * 1000 -
      Date.now();
    const remaining = Math.min(
      limits.maxCostUsd - row.costUsd,
      settings.budgets.value.perRunUsd - row.costUsd,
      await remainingSpend(db, settings.budgets.value, project.id, project.budgetUsd),
    );
    if (
      remaining < 0 ||
      remainingMs <= 0 ||
      !record ||
      record.journal.models.length > Math.min(16, settings.budgets.value.maxSteps)
    )
      throw new EvalError('EVAL_LIMIT');
    if ((await getControl(db)).paused) throw new RunSuspension('paused', 'Paused by the operator.');
    return await options.generate({
      ...request,
      privateOnly: request.privateOnly || row.privateOnly || project.privacy === 'private',
      remainingBudgetUsd: Math.min(request.remainingBudgetUsd, remaining),
      signal: AbortSignal.any([
        AbortSignal.timeout(Math.min(remainingMs, 45_000)),
        ...(request.signal ? [request.signal] : []),
        ...(options.signal ? [options.signal] : []),
      ]),
    });
  } finally {
    let reusable = false;
    try {
      if (locked) await lease.query('SELECT pg_advisory_unlock(72839102)');
      reusable = true;
    } finally {
      lease.release(!reusable);
    }
  }
}

export async function executeEvaluation(options: EvalExecutorOptions, id: string) {
  const { database: db } = options;
  const lease = await db.pool.connect();
  let locked = false;
  try {
    locked =
      (await lease.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(72839110) AS locked'))
        .rows[0]?.locked ?? false;
    if (!locked || (await getControl(db)).paused || options.signal?.aborted) return;
    const [existing] = await db.orm.select().from(evalRuns).where(eq(evalRuns.id, id));
    if (!existing || !['queued', 'running'].includes(existing.status)) return;
    const [run] = await db.orm
      .update(evalRuns)
      .set({ status: 'running', startedAt: sql`COALESCE(${evalRuns.startedAt},now())` })
      .where(eq(evalRuns.id, id))
      .returning();
    if (!run?.startedAt) throw new EvalError('EVAL_INVALID');
    const limits = evalLimitsSchema.parse(run.limits);
    const suites = storedSuites(run);
    const cases = await db.orm
      .select()
      .from(evalResults)
      .where(eq(evalResults.evalRunId, id))
      .orderBy(asc(evalResults.ordinal));
    for (const item of cases) {
      if (item.status === 'done') continue;
      if (item.status === 'uncertain') {
        await db.orm
          .update(evalRuns)
          .set({ status: 'uncertain', completedAt: new Date() })
          .where(eq(evalRuns.id, id));
        break;
      }
      const suite = suites.find((suite) => suite.suite === item.suite);
      const input = suite?.cases.find((entry) => entry.id === item.caseId);
      const [project] = await db.orm
        .select()
        .from(projects)
        .where(and(eq(projects.id, run.projectId), eq(projects.userId, run.userId)));
      if (!suite || !input || !project) throw new EvalError('EVAL_INVALID');
      const remainingMs =
        run.startedAt.getTime() +
        Math.min(
          limits.maxWallTimeSeconds,
          options.getSettings().budgets.value.maxWallTimeSeconds,
        ) *
          1000 -
        Date.now();
      if (remainingMs <= 0 || options.signal?.aborted) throw new EvalError('EVAL_LIMIT');
      const persistence = databasePersistence(db, run, item);
      const result = await evaluateCase({
        id: item.id,
        suite: suite.suite,
        suiteHash: suiteHash(suite),
        input,
        preset: presetForCase(item),
        mode: run.mode === 'fixture' ? 'fixture' : 'configured',
        projectId: project.id,
        privateOnly:
          run.privateOnly ||
          project.privacy === 'private' ||
          input.fixtures.some((fixture) => fixture.privateOnly),
        persistence,
        maxCostUsd: limits.maxCostUsd,
        maxSteps: Math.min(limits.maxSteps, options.getSettings().budgets.value.maxSteps),
        maxWallTimeSeconds: Math.max(1, Math.min(60, Math.floor(remainingMs / 1000))),
        remainingBudget: async () => {
          if (run.mode === 'fixture') return 0;
          const [current] = await db.orm
            .select({ costUsd: evalRuns.costUsd })
            .from(evalRuns)
            .where(eq(evalRuns.id, id));
          if (!current) return -1;
          return Math.min(
            limits.maxCostUsd - current.costUsd,
            options.getSettings().budgets.value.perRunUsd - current.costUsd,
            await remainingSpend(
              db,
              options.getSettings().budgets.value,
              project.id,
              project.budgetUsd,
            ),
          );
        },
        generate: (request) => admittedGeneration(options, id, item.id, request),
        rules: async () => (await readSettings(db)).security.value.rules,
        paused: async () => (await getControl(db)).paused,
        judge: run.judge,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const record = await persistence.load();
      const uncertain =
        record?.journal.models.some(
          (entry) => entry.status === 'intent' || entry.status === 'uncertain',
        ) ?? true;
      await finishCase(db, item, result, uncertain);
      if (uncertain || ['paused', 'budget_exceeded'].includes(result.outcome)) {
        await db.orm
          .update(evalRuns)
          .set({ status: uncertain ? 'uncertain' : 'failed', completedAt: new Date() })
          .where(eq(evalRuns.id, id));
        return evaluationReport(db, run.userId, id);
      }
    }
    await db.orm
      .update(evalRuns)
      .set({ status: 'completed', completedAt: new Date() })
      .where(and(eq(evalRuns.id, id), eq(evalRuns.status, 'running')));
    return evaluationReport(db, run.userId, id);
  } catch (error) {
    if (locked)
      await db.orm
        .update(evalRuns)
        .set({
          status: error instanceof RunSuspension ? 'uncertain' : 'failed',
          completedAt: new Date(),
        })
        .where(and(eq(evalRuns.id, id), eq(evalRuns.status, 'running')));
    throw error;
  } finally {
    let reusable = false;
    try {
      if (locked) await lease.query('SELECT pg_advisory_unlock(72839110)');
      reusable = true;
    } finally {
      lease.release(!reusable);
    }
  }
}

export async function nextEvaluation(db: Database) {
  const [row] = await db.orm
    .select({ id: evalRuns.id })
    .from(evalRuns)
    .where(sql`${evalRuns.status} IN ('queued','running')`)
    .orderBy(asc(evalRuns.createdAt))
    .limit(1);
  return row?.id ?? null;
}
