import { z } from 'zod';
import { workId } from './work';
import { agentRoleSchema } from './missions';

export const memoryScopeSchema = z.enum(['global', 'project', 'agent']);
export const memoryKindSchema = z.enum(['preference', 'fact', 'episode']);
const fields = {
  scope: memoryScopeSchema,
  projectId: workId.nullable().default(null),
  agentId: agentRoleSchema.nullable().default(null),
  kind: memoryKindSchema,
  content: z.string().trim().min(1).max(4000),
  importance: z.number().finite().min(0).max(1).default(0.5),
  sensitivity: z.enum(['low', 'private']).default('low'),
};
export const memoryInputSchema = z
  .strictObject(fields)
  .refine(
    (value) =>
      value.scope === 'global'
        ? value.projectId === null && value.agentId === null
        : value.projectId !== null && (value.scope === 'agent') === (value.agentId !== null),
    { message: 'Choose a project for project/agent memory and an agent only for agent memory.' },
  );
export const memorySchema = z.strictObject({
  ...fields,
  id: workId,
  status: z.enum(['proposed', 'accepted', 'rejected']),
  sensitivity: z.enum(['low', 'private']),
  sourceRunId: workId.nullable(),
  sourceMessageId: workId.nullable(),
  sourceQuote: z.string().max(1200).nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Memory = z.infer<typeof memorySchema>;
export type MemoryInput = z.infer<typeof memoryInputSchema>;
export const memoryUpdateSchema = z.strictObject({
  version: z.number().int().positive(),
  content: z.string().trim().min(1).max(4000),
  importance: z.number().finite().min(0).max(1),
  status: z.enum(['proposed', 'accepted', 'rejected']),
});
export const memoryQuerySchema = z.strictObject({
  projectId: workId.optional(),
  status: z.enum(['proposed', 'accepted', 'rejected']).optional(),
});
export const memorySearchSchema = z.strictObject({
  projectId: workId,
  agentId: agentRoleSchema.default('cos'),
  query: z.string().trim().max(2000).default(''),
  tokenBudget: z.number().int().min(100).max(3000).default(1200),
});
export const forgetMemorySchema = z.strictObject({
  projectId: workId.nullable(),
  text: z.string().trim().min(2).max(200),
});
export const memoryCandidatesSchema = z.strictObject({
  candidates: z
    .array(
      z.strictObject({
        kind: memoryKindSchema,
        content: z.string().trim().min(1).max(4000),
        quote: z.string().trim().min(1).max(1200),
        sensitivity: z.enum(['low', 'private']),
        importance: z.number().finite().min(0).max(1),
      }),
    )
    .max(8),
});
export const knowledgeJobPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('extract'), runId: workId }),
  z.strictObject({ kind: z.literal('ingest'), sourceId: workId }),
  z.strictObject({ kind: z.literal('reindex'), generationId: workId }),
]);
export const knowledgeJobSchema = z.strictObject({
  id: workId,
  kind: z.string(),
  projectId: workId.nullable(),
  runId: workId.nullable(),
  status: z.enum(['queued', 'running', 'completed', 'blocked', 'failed']),
  step: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative(),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type KnowledgeJob = z.infer<typeof knowledgeJobSchema>;
