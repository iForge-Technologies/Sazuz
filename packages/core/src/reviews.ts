import { z } from 'zod';
import { workId } from './work';

export const reviewModeSchema = z.enum(['off', 'external_actions', 'all']);
export const projectReviewSchema = z.strictObject({
  projectId: workId,
  mode: reviewModeSchema,
  version: z.number().int().positive(),
});
export const projectReviewUpdateSchema = z.strictObject({
  mode: reviewModeSchema,
  expectedVersion: z.number().int().positive(),
});
const checkSchema = z.strictObject({ passed: z.boolean(), reason: z.string().min(1).max(1000) });
export const reviewVerdictSchema = z.strictObject({
  criteria: z
    .array(checkSchema.extend({ id: z.string().regex(/^c[1-9][0-9]?$/) }))
    .min(1)
    .max(32),
  grounding: checkSchema,
  policy: checkSchema,
  tone: checkSchema,
  feedback: z.string().max(4000),
});
export const reviewEvidenceSchema = z.strictObject({
  reference: z.string().max(4096),
  kind: z.enum(['receipt', 'http', 'knowledge', 'artifact']),
  resolved: z.boolean(),
  text: z.string().max(6000),
  privateOnly: z.boolean(),
});
export const reviewRecordSchema = z.strictObject({
  id: workId,
  runId: workId,
  sourceKey: z.string().max(256),
  kind: z.enum(['output', 'action']),
  subjectHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['pending', 'accepted', 'rejected']),
  verdict: reviewVerdictSchema.nullable(),
  evidence: z.array(reviewEvidenceSchema).max(32),
  attempts: z.number().int().nonnegative().max(2),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>;
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;
