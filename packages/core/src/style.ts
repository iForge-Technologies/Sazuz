import { z } from 'zod';
import { workId } from './work';

export const styleSourceSchema = z.strictObject({
  callId: workId,
  runId: workId,
  missionId: workId,
  projectId: workId,
  tool: z.enum(['gmail.send', 'email.send']),
  accountId: z.string().min(1).max(100),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  characters: z.number().int().min(20).max(6000),
});
export const styleSourcesSchema = z.array(styleSourceSchema).max(3);
export const styleProjectQuerySchema = z.strictObject({ projectId: workId });
export const styleSentSourceSchema = styleSourceSchema.omit({ sha256: true }).extend({
  subject: z.string().max(200),
  privateOnly: z.boolean(),
  sentAt: z.iso.datetime(),
});
export const styleSentPreviewSchema = z.strictObject({
  requestId: z.uuid(),
  projectId: workId,
  callIds: z
    .array(workId)
    .min(1)
    .max(3)
    .refine((ids) => new Set(ids).size === ids.length),
  consent: z.literal(true),
  privateOnly: z.boolean().default(true),
});
export const styleComparisonRequestSchema = z.strictObject({
  requestId: z.uuid(),
  projectId: workId,
  task: z.string().trim().min(20).max(4000),
  privateOnly: z.boolean().default(true),
});
export const styleDraftSchema = z.strictObject({ draft: z.string().trim().min(1).max(6000) });
export const styleVoteSchema = z.strictObject({ vote: z.enum(['A', 'B', 'tie']) });
export const styleComparisonSchema = z.strictObject({
  id: workId,
  requestId: z.uuid(),
  projectId: workId,
  task: z.string().max(4000),
  status: z.enum(['generating', 'ready', 'voted', 'failed']),
  privateOnly: z.boolean(),
  costUsd: z.number().nonnegative(),
  errorCode: z.string().nullable(),
  drafts: z.strictObject({ A: z.string().max(6000), B: z.string().max(6000) }).nullable(),
  vote: styleVoteSchema.shape.vote.nullable(),
  reveal: z
    .strictObject({
      styledLabel: z.enum(['A', 'B']),
      preference: z.enum(['styled', 'generic', 'tie']),
      skillId: workId,
      revision: z.number().int().positive(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .nullable(),
  createdAt: z.iso.datetime(),
  votedAt: z.iso.datetime().nullable(),
});
export type StyleComparison = z.infer<typeof styleComparisonSchema>;
