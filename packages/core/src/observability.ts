import { z } from 'zod';
import { workId } from './work';

const amount = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
export const costQuerySchema = z.strictObject({ projectId: workId.optional() });
export const costSummarySchema = z.strictObject({
  costUsd: amount,
  calls: count,
  inputTokens: count,
  outputTokens: count,
  failedCalls: count,
  estimatedCalls: count,
});
export const costGroupSchema = costSummarySchema.extend({
  key: z.string().max(512),
  label: z.string().max(512),
});
export const costThresholdSchema = z.strictObject({
  period: z.enum(['day', 'month', 'project']),
  capUsd: amount,
  spentUsd: amount,
  percentUsed: amount.nullable(),
  reached: z.array(z.number().int().min(1).max(100)),
});
export const costDashboardSchema = costSummarySchema.extend({
  asOf: z.iso.datetime(),
  monthStart: z.iso.datetime(),
  monthEnd: z.iso.datetime(),
  projectId: workId.nullable(),
  todayUsd: amount,
  allTimeUsd: amount,
  forecastUsd: amount,
  elapsedDays: z.number().min(1).max(31),
  daysInMonth: z.number().int().min(28).max(31),
  thresholds: z.array(costThresholdSchema).max(3),
  groups: z.strictObject({
    agent: z.array(costGroupSchema).max(500),
    project: z.array(costGroupSchema).max(500),
    model: z.array(costGroupSchema).max(500),
    day: z.array(costGroupSchema).max(31),
  }),
});
export const telemetryStatusSchema = z.strictObject({
  enabled: z.boolean(),
  configured: z.boolean(),
  settingsVersion: count,
  counts: z.strictObject({
    intent: count,
    done: count,
    failed: count,
    uncertain: count,
    blocked: count,
  }),
  latest: z
    .array(
      z.strictObject({
        id: workId,
        status: z.enum(['intent', 'done', 'failed', 'uncertain', 'blocked']),
        code: z
          .enum([
            'collector_rejected',
            'delivery_unknown',
            'configuration_changed',
            'policy_blocked',
            'credential_unavailable',
          ])
          .nullable(),
        createdAt: z.iso.datetime(),
      }),
    )
    .max(20),
});

export function utcCostPeriod(input: Date) {
  const now = z.date().parse(input);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    start,
    end,
    day,
    elapsedDays: Math.max(1, (now.getTime() - start.getTime()) / 86_400_000),
    daysInMonth: (end.getTime() - start.getTime()) / 86_400_000,
  };
}

export function costThreshold(
  period: z.infer<typeof costThresholdSchema>['period'],
  capUsd: number,
  spentUsd: number,
  percentages: number[],
) {
  return costThresholdSchema.parse({
    period,
    capUsd,
    spentUsd,
    percentUsed: capUsd === 0 ? null : (spentUsd / capUsd) * 100,
    reached: [...new Set(percentages)]
      .sort((a, b) => a - b)
      .filter((value) => (capUsd === 0 ? spentUsd > 0 : spentUsd * 100 >= capUsd * value)),
  });
}
