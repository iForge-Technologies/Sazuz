import { z } from 'zod';
import {
  evalPresetSchema,
  evalReportSchema,
  evalSuiteSchema,
  EvalError,
  type EvalSuite,
  type EvalPreset,
} from '@sazuz/core/evals';
import { workId } from '@sazuz/core/work';
import { workKey } from '@sazuz/db';
import { evaluateCase } from './runner.js';
import { memoryPersistence, type EvalPersistence } from './journal.js';
import { parseSuite, suiteSummary, suiteHash } from './loader.js';

export const fixturePlanSchema = z.strictObject({
  id: workId,
  createdAt: z.iso.datetime(),
  suites: z.array(evalSuiteSchema).min(1).max(8),
  presets: z.array(evalPresetSchema).min(1).max(4),
  cases: z
    .array(
      z.strictObject({
        id: workId,
        suite: z.string(),
        caseId: z.string(),
        preset: evalPresetSchema,
      }),
    )
    .min(1)
    .max(128),
});
export type FixturePlan = z.infer<typeof fixturePlanSchema>;
export function createFixturePlan(suites: EvalSuite[], presets: EvalPreset[]): FixturePlan {
  const parsed = suites.map(parseSuite);
  if (
    new Set(presets).size !== presets.length ||
    new Set(parsed.map((suite) => suite.suite)).size !== parsed.length ||
    parsed.some((suite) => presets.some((preset) => !suite.model_presets.includes(preset)))
  )
    throw new EvalError('EVAL_INVALID');
  return fixturePlanSchema.parse({
    id: workKey('evl'),
    createdAt: new Date().toISOString(),
    suites: parsed,
    presets,
    cases: parsed.flatMap((suite) =>
      presets.flatMap((preset) =>
        suite.cases.map((item) => ({
          id: workKey('evc'),
          suite: suite.suite,
          caseId: item.id,
          preset,
        })),
      ),
    ),
  });
}
export async function runFixturePlan(
  input: unknown,
  persistence: (id: string) => EvalPersistence = () => memoryPersistence(),
) {
  const plan = fixturePlanSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(plan)) > 1_200_000) throw new EvalError('EVAL_LIMIT');
  const deadline = new Date(plan.createdAt).getTime() + 600_000;
  const results = [];
  for (const entry of plan.cases) {
    const remainingSeconds = Math.floor((deadline - Date.now()) / 1000);
    if (remainingSeconds <= 0) throw new EvalError('EVAL_LIMIT');
    const suite = plan.suites.find((item) => item.suite === entry.suite);
    const item = suite?.cases.find((item) => item.id === entry.caseId);
    if (
      !suite ||
      !item ||
      !plan.presets.includes(entry.preset) ||
      !suite.model_presets.includes(entry.preset)
    )
      throw new EvalError('EVAL_INVALID');
    results.push(
      await evaluateCase({
        id: entry.id,
        suite: suite.suite,
        suiteHash: suiteHash(suite),
        input: item,
        preset: entry.preset,
        mode: 'fixture',
        projectId: 'eval-fixture',
        privateOnly: true,
        persistence: persistence(entry.id),
        maxCostUsd: 0,
        maxWallTimeSeconds: Math.min(60, remainingSeconds),
        remainingBudget: () => Promise.resolve(0),
      }),
    );
  }
  return evalReportSchema.parse({
    id: plan.id,
    projectId: null,
    mode: 'fixture',
    judge: false,
    suites: plan.suites.map(suiteSummary),
    presets: plan.presets,
    status: 'completed',
    totalCases: plan.cases.length,
    completedCases: results.length,
    passedCases: results.filter((item) => item.passed).length,
    costUsd: 0,
    judgeCostUsd: 0,
    maxCostUsd: 0,
    createdAt: plan.createdAt,
    completedAt: new Date().toISOString(),
    results,
  });
}
