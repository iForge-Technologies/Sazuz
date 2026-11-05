import { z } from 'zod';
import { llmMessageSchema, llmToolCallSchema } from '@sazuz/llm/contracts';
export const checkpointSchema = z.strictObject({
  messages: z
    .array(llmMessageSchema)
    .max(1000)
    .refine(
      (messages) => messages.every((message) => message.role !== 'user' || !message.images?.length),
      'Pixels cannot be checkpointed.',
    ),
  step: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative(),
  startedAt: z.iso.datetime(),
  tainted: z.boolean(),
  privateOnly: z.boolean().default(false),
  seen: z.record(z.string(), z.number().int().nonnegative()),
  pendingCalls: z.array(llmToolCallSchema),
  nextCall: z.number().int().nonnegative(),
  status: z.enum([
    'running',
    'completed',
    'waiting_approval',
    'budget_exceeded',
    'paused',
    'failed',
  ]),
  reason: z.string().nullable(),
  failures: z.number().int().nonnegative(),
});
export type RunCheckpoint = z.infer<typeof checkpointSchema>;
export const runLimitsSchema = z.strictObject({
  maxSteps: z.number().int().min(1).max(1000),
  maxCostUsd: z.number().finite().min(0),
  maxWallTimeSeconds: z.number().int().min(1).max(86400),
});
export type RunLimits = z.infer<typeof runLimitsSchema>;
export class RunError extends Error {
  constructor(readonly code: 'RUN_INVALID' | 'RUN_PERSISTENCE_FAILED' | 'RUN_PROVIDER_FAILED') {
    super('The run could not continue safely.');
    this.name = 'RunError';
  }
}
/** A verified stop preserves pending evidence instead of inventing a tool observation. */
export class RunSuspension extends Error {
  constructor(
    readonly status: 'waiting_approval' | 'paused' | 'budget_exceeded' | 'failed',
    reason: string,
  ) {
    super(reason);
    this.name = 'RunSuspension';
  }
}
