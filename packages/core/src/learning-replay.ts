import { z } from 'zod';
import { workId } from './work';
import { browserProfileId, browserRef, browserSessionId } from './browser';
import { elementFingerprintSchema, learnedProgramSchema } from './learning';
import { runStatusSchema } from './missions';

export const learnedInputsSchema = z
  .record(
    z.string(),
    z.union([
      z.string().max(4000),
      z
        .array(z.record(z.string(), z.string().max(4000)))
        .min(1)
        .max(20),
    ]),
  )
  .refine((input) => JSON.stringify(input).length <= 24000);
export const learnedReplayInputSchema = z
  .strictObject({
    requestId: z.uuid(),
    revision: z.number().int().positive(),
    inputs: learnedInputsSchema,
    mode: z.enum(['rehearsal', 'live']),
    profileId: browserProfileId.optional(),
    allowRepair: z.boolean().default(true),
  })
  .refine((body) => body.mode !== 'live' || !!body.profileId);
export const rehearsalStepSchema = z.strictObject({
  stepId: z.string(),
  iteration: z.number().int().nonnegative().nullable(),
  operation: z.enum(['navigate', 'click', 'fill', 'select']),
  intent: z.string().max(500),
  target: z.string().max(4096),
  parameter: z.string().nullable(),
  result: z.literal('simulated'),
});
export const learnedReplaySchema = z.strictObject({
  id: workId,
  skillId: workId,
  revision: z.number().int().positive(),
  projectId: workId,
  mode: z.enum(['rehearsal', 'live']),
  runId: workId.nullable(),
  missionId: workId.nullable(),
  status: z.union([runStatusSchema, z.literal('simulated')]),
  evidence: z.array(rehearsalStepSchema).max(200),
  allowRepair: z.boolean(),
  privateOnly: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type LearnedReplay = z.infer<typeof learnedReplaySchema>;
export const learnedRevisionInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  description: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .regex(/^[^\r\n]+$/),
  program: learnedProgramSchema,
  enabled: z.boolean(),
});
export const learnedRepairSchema = z.strictObject({
  id: workId,
  replayId: workId,
  actionIndex: z.number().int().nonnegative().max(199),
  stepId: z.string(),
  status: z.enum(['generating', 'proposed', 'failed', 'accepted', 'rejected']),
  target: elementFingerprintSchema.nullable(),
  reason: z.string().max(500).nullable(),
  costUsd: z.number().nonnegative(),
  acceptedRevision: z.number().int().positive().nullable(),
});
export const learnedRepairDecisionSchema = z.strictObject({
  action: z.enum(['accept', 'reject']),
  expectedRevision: z.number().int().positive(),
});
export const learnedCursorSchema = z.strictObject({
  index: z.number().int().min(0).max(200),
  sessionId: browserSessionId.nullable(),
  ref: browserRef.nullable(),
  finished: z.boolean(),
  awaiting: z
    .strictObject({
      key: z.string().max(256),
      stage: z.enum(['open', 'resolve', 'act', 'close']),
    })
    .nullable(),
});
export type LearnedCursor = z.infer<typeof learnedCursorSchema>;
