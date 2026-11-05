import { z } from 'zod';
import { workId } from './work';
import { runSchema, stepSchema, approvalSchema } from './missions';

export const replayModelSchema = z.strictObject({
  providerId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  modelId: z.string().trim().min(1).max(200),
});
export const replaySkillSchema = z.strictObject({
  id: workId,
  revision: z.number().int().positive(),
});
export const forkInputSchema = z.strictObject({
  requestId: z.uuid(),
  stepId: workId,
  model: replayModelSchema.nullable().default(null),
  prompt: z.string().trim().max(16000).default(''),
  skill: replaySkillSchema.nullable().default(null),
});
export const replaySchema = z.strictObject({
  runId: workId,
  sourceRunId: workId,
  sourceStepId: workId,
  sourceOrdinal: z.number().int().nonnegative(),
  model: replayModelSchema.nullable(),
  skill: replaySkillSchema.nullable(),
  privateOnly: z.boolean(),
  reconstructed: z.boolean(),
  mocked: z.literal(true),
  createdAt: z.iso.datetime(),
});
export const runDetailSchema = z.strictObject({
  run: runSchema,
  title: z.string(),
  projectId: workId,
  steps: z.array(stepSchema),
  approvals: z.array(approvalSchema),
  replay: replaySchema.nullable(),
  forks: z.array(replaySchema),
  source: runSchema.nullable(),
});
