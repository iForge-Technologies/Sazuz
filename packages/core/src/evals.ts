import { z } from 'zod';
import { workId } from './work';
import { SazuzError } from './errors';

export const evalPresetSchema = z.enum(['balanced', 'budget', 'quality', 'private']);
export const evalModeSchema = z.enum(['fixture', 'configured']);
const name = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const toolName = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/)
  .max(128);
const effect = z.enum(['read', 'write', 'send', 'delete', 'spend', 'publish']);
export const evalFlagSchema = z.enum([
  'untrusted_content',
  'prompt_injection',
  'scope_revoked',
  'secret_redacted',
  'interrupted',
]);
export const evalExpectationSchema = z.union([
  z.strictObject({ tool_called: z.strictObject({ name: toolName, args: z.json().optional() }) }),
  z.strictObject({ no_effect: effect }),
  z.strictObject({ flagged: evalFlagSchema }),
  z.strictObject({ text_contains: z.string().min(1).max(2000) }),
  z.strictObject({ llm_judge: z.string().min(1).max(2000) }),
]);
export const evalFixtureSchema = z.strictObject({
  name: toolName,
  args: z.json(),
  output: z.json(),
  privateOnly: z.boolean().default(false),
});
export const evalTurnSchema = z.strictObject({
  text: z.string().max(16000),
  toolCalls: z
    .array(z.strictObject({ id: z.string().min(1).max(128), name: toolName, args: z.json() }))
    .max(8)
    .default([]),
});
export const evalCaseSchema = z.strictObject({
  id: name,
  task: z.string().min(1).max(16000),
  tools: z
    .array(toolName)
    .min(1)
    .max(20)
    .refine((items) => new Set(items).size === items.length),
  fixtures: z.array(evalFixtureSchema).max(30),
  external: z
    .array(
      z.strictObject({
        kind: z.enum(['email', 'page', 'document', 'tool']),
        text: z.string().max(16000),
      }),
    )
    .max(4)
    .default([]),
  fixtureTurns: z.array(evalTurnSchema).min(1).max(12),
  expect: z.array(evalExpectationSchema).min(1).max(20),
  maxSteps: z.number().int().min(1).max(16).default(8),
  allowedEffects: z
    .array(effect)
    .max(6)
    .default(['read', 'write', 'send', 'delete', 'spend', 'publish']),
  policyPreset: z.enum(['cautious', 'balanced', 'autonomous']).default('balanced'),
  knownRecipient: z.boolean().default(false),
});
export const evalSuiteSchema = z.strictObject({
  version: z.literal(1),
  suite: name,
  description: z.string().min(1).max(500),
  model_presets: z
    .array(evalPresetSchema)
    .min(1)
    .max(4)
    .refine((items) => new Set(items).size === items.length),
  cases: z
    .array(evalCaseSchema)
    .min(1)
    .max(24)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length),
});
export type EvalSuite = z.infer<typeof evalSuiteSchema>;
export type EvalCase = z.infer<typeof evalCaseSchema>;
export type EvalPreset = z.infer<typeof evalPresetSchema>;
export type EvalMode = z.infer<typeof evalModeSchema>;
export const evalSuiteSummarySchema = z.strictObject({
  suite: name,
  version: z.literal(1),
  description: z.string(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  cases: z.number().int().positive(),
  presets: z.array(evalPresetSchema),
});
export const evalRequestSchema = z
  .strictObject({
    requestId: z.uuid(),
    projectId: workId,
    suites: z
      .array(name)
      .min(1)
      .max(8)
      .refine((items) => new Set(items).size === items.length),
    presets: z
      .array(evalPresetSchema)
      .min(1)
      .max(4)
      .refine((items) => new Set(items).size === items.length),
    mode: evalModeSchema.default('fixture'),
    judge: z.boolean().default(false),
  })
  .refine(
    (input) => !input.judge || input.mode === 'configured',
    'The optional judge requires configured mode.',
  );
export const evalGradeSchema = z.strictObject({
  kind: z.enum(['tool', 'effect', 'flag', 'text', 'judge', 'integrity']),
  description: z.string().max(2000),
  passed: z.boolean().nullable(),
  evidence: z.string().max(4000),
});
export const evalDecisionSchema = z.strictObject({
  callId: z.string(),
  tool: toolName,
  args: z.json(),
  effect,
  action: z.enum(['allow', 'ask', 'deny']),
  ruleId: z.string(),
  tainted: z.boolean(),
});
export const evalDispatchSchema = z.strictObject({
  key: z.string(),
  tool: toolName,
  args: z.json(),
  effect,
  matchedFixture: z.boolean(),
});
export const evalCaseResultSchema = z.strictObject({
  id: workId,
  suite: name,
  suiteHash: z.string(),
  caseId: name,
  preset: evalPresetSchema,
  mode: evalModeSchema,
  securityPreset: z.enum(['cautious', 'balanced', 'autonomous']),
  outcome: z.enum(['completed', 'waiting_approval', 'budget_exceeded', 'paused', 'failed']),
  passed: z.boolean(),
  text: z.string().max(16000),
  flags: z.array(evalFlagSchema),
  decisions: z.array(evalDecisionSchema).max(128),
  dispatches: z.array(evalDispatchSchema).max(128),
  grades: z.array(evalGradeSchema).max(24),
  steps: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative(),
  judgeCostUsd: z.number().finite().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  latencyMs: z.number().finite().nonnegative(),
  models: z.array(z.strictObject({ providerId: z.string(), modelId: z.string() })).max(64),
  unauthorizedEffects: z.number().int().nonnegative(),
  liveDispatches: z.number().int().nonnegative(),
});
export type EvalCaseResult = z.infer<typeof evalCaseResultSchema>;
export const evalRunSchema = z.strictObject({
  id: workId,
  projectId: workId.nullable(),
  mode: evalModeSchema,
  judge: z.boolean(),
  suites: z.array(evalSuiteSummarySchema),
  presets: z.array(evalPresetSchema),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'uncertain']),
  totalCases: z.number().int().min(1).max(128),
  completedCases: z.number().int().nonnegative(),
  passedCases: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative(),
  judgeCostUsd: z.number().finite().nonnegative(),
  maxCostUsd: z.number().finite().nonnegative(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
export const evalReportSchema = evalRunSchema.extend({
  results: z.array(evalCaseResultSchema).max(128),
});
export type EvalReport = z.infer<typeof evalReportSchema>;
export class EvalError extends SazuzError {
  constructor(
    code: 'EVAL_INVALID' | 'EVAL_NOT_FOUND' | 'EVAL_CONFLICT' | 'EVAL_LIMIT' | 'EVAL_UNCERTAIN',
  ) {
    super(
      code,
      {
        EVAL_INVALID: 'The evaluation input is invalid or too large.',
        EVAL_NOT_FOUND: 'The evaluation is unavailable.',
        EVAL_CONFLICT: 'This evaluation request already has different inputs.',
        EVAL_LIMIT: 'The evaluation budget or execution limit was reached.',
        EVAL_UNCERTAIN: 'An interrupted model request cannot be repeated automatically.',
      }[code],
    );
    this.name = 'EvalError';
  }
}
