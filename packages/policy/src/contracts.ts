import { z } from 'zod';

export const toolEffectSchema = z.enum(['read', 'write', 'send', 'delete', 'spend', 'publish']);
export type ToolEffect = z.infer<typeof toolEffectSchema>;
export const policyActionSchema = z.enum(['allow', 'ask', 'deny']);
export type PolicyAction = z.infer<typeof policyActionSchema>;
export const policyPresetSchema = z.enum(['cautious', 'balanced', 'autonomous']);
export type PolicyPreset = z.infer<typeof policyPresetSchema>;
export const toolScopeSchema = z.enum(['internal', 'external']);
export type ToolScope = z.infer<typeof toolScopeSchema>;

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
const scalar = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]);
const field = z
  .string()
  .max(256)
  .regex(/^(?:args(?:\.[a-zA-Z0-9_-]+){1,8}|run\.tainted|recipient\.known)$/)
  .refine(
    (value) =>
      !value.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part)),
  );

/** Declarative comparisons only: conditions never execute code from a rule. */
export const policyConditionSchema = z
  .strictObject({
    field,
    op: z.enum([
      'eq',
      'ne',
      'in',
      'notIn',
      'startsWith',
      'endsWith',
      'allEndsWith',
      'contains',
      'exists',
      'gt',
      'gte',
      'lt',
      'lte',
    ]),
    value: z.union([scalar, z.array(scalar).max(100)]).optional(),
  })
  .superRefine((condition, context) => {
    const op = condition.op;
    const value = condition.value;
    const valid =
      op === 'exists'
        ? value === undefined || typeof value === 'boolean'
        : ['in', 'notIn'].includes(op)
          ? Array.isArray(value) && value.length > 0
          : ['startsWith', 'endsWith', 'allEndsWith'].includes(op)
            ? typeof value === 'string' && value.length > 0
            : ['gt', 'gte', 'lt', 'lte'].includes(op)
              ? typeof value === 'number'
              : value !== undefined && !Array.isArray(value);
    if (!valid)
      context.addIssue({
        code: 'custom',
        message: 'The comparison value does not match the condition operator.',
      });
  });
export type PolicyCondition = z.infer<typeof policyConditionSchema>;

export const policyRuleSchema = z.strictObject({
  id: identifier,
  description: z.string().max(500).optional(),
  scope: z
    .discriminatedUnion('type', [
      z.strictObject({ type: z.literal('global') }),
      z.strictObject({ type: z.literal('project'), projectId: identifier }),
      z.strictObject({
        type: z.literal('agent'),
        agentId: identifier,
        projectId: identifier.optional(),
      }),
    ])
    .default({ type: 'global' }),
  match: z
    .strictObject({
      tool: z
        .string()
        .max(128)
        .regex(/^(?:\*|[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*(?:\.\*)?)$/)
        .optional(),
      effect: z.union([toolEffectSchema, z.array(toolEffectSchema).min(1).max(6)]).optional(),
      connector: identifier.optional(),
      scope: toolScopeSchema.optional(),
    })
    .default({}),
  when: z.array(policyConditionSchema).max(30).default([]),
  action: policyActionSchema,
  limits: z
    .strictObject({
      perHour: z.number().int().min(1).max(100_000).optional(),
      perRun: z.number().int().min(1).max(100_000).optional(),
    })
    .optional(),
  timeWindow: z
    .strictObject({
      startHourUtc: z.number().int().min(0).max(23),
      endHourUtc: z.number().int().min(0).max(23),
      weekdaysUtc: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    })
    .optional(),
});
export type PolicyRule = z.infer<typeof policyRuleSchema>;

export const policyRequestSchema = z.strictObject({
  tool: identifier,
  effect: z.string().max(64).optional(),
  effectKnown: z.boolean().optional(),
  scope: toolScopeSchema.default('external'),
  connector: identifier.optional(),
  moneyMovement: z.boolean().default(false),
  args: z.unknown().optional(),
  agentId: identifier,
  projectId: identifier,
  tainted: z.boolean(),
  allowedEffects: z.array(toolEffectSchema).max(6).optional(),
  askEffects: z.array(toolEffectSchema).max(6).optional(),
  preset: policyPresetSchema.default('balanced'),
  rules: z.array(policyRuleSchema).max(1000).default([]),
  knownRecipient: z.boolean().default(false),
  now: z.date().optional(),
  usage: z
    .record(
      z.string(),
      z.strictObject({ hour: z.number().int().nonnegative(), run: z.number().int().nonnegative() }),
    )
    .optional(),
  budget: z
    .strictObject({
      remainingSteps: z.number().int(),
      remainingUsd: z.number().finite(),
      remainingMs: z.number().finite(),
      estimatedCostUsd: z.number().finite().nonnegative().default(0),
    })
    .optional(),
  paused: z.boolean().default(false),
});
export type PolicyRequest = z.input<typeof policyRequestSchema>;

export interface PolicyDecision {
  action: PolicyAction;
  reason: string;
  ruleId: string;
  effect: ToolEffect;
  matchedRuleIds: string[];
}

export function normalizeEffect(effect: unknown): { effect: ToolEffect; known: boolean } {
  const parsed = toolEffectSchema.safeParse(effect);
  return parsed.success ? { effect: parsed.data, known: true } : { effect: 'write', known: false };
}
