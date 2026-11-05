import { z } from 'zod';

export const workId = z.string().regex(/^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/);
export const projectInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  brief: z.string().max(12000).default(''),
  privacy: z.enum(['standard', 'private']).default('standard'),
  budgetUsd: z.number().min(0).max(10000).default(5),
});
export const projectSchema = projectInput.extend({ id: workId, createdAt: z.iso.datetime() });
export const threadInput = z.strictObject({
  projectId: workId,
  title: z.string().trim().min(1).max(160),
});
export const threadSchema = threadInput.extend({ id: workId, createdAt: z.iso.datetime() });
export const messageSchema = z.object({
  id: workId,
  threadId: workId,
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  trust: z.enum(['trusted', 'untrusted']),
  createdAt: z.iso.datetime(),
  providerId: z.string().nullable(),
  modelId: z.string().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  usageEstimated: z.boolean(),
  toolCalls: z.array(z.object({ id: z.string(), name: z.string(), args: z.unknown() })),
});
export type WorkMessage = z.infer<typeof messageSchema>;
export const chatInput = z.strictObject({
  content: z.string().trim().min(1).max(24000),
  requestId: z.string().uuid(),
  voiceReceiptId: workId.optional(),
});
export const chatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text.delta'), text: z.string() }),
  z.object({ type: z.literal('tool.call'), id: z.string(), name: z.string(), args: z.unknown() }),
  z.object({
    type: z.literal('tool.result'),
    id: z.string(),
    name: z.string(),
    output: z.unknown(),
    status: z.enum(['done', 'denied', 'waiting_approval', 'error']),
  }),
  z.object({ type: z.literal('message.completed'), message: messageSchema }),
  z.object({ type: z.literal('run.status'), status: z.string(), message: z.string().optional() }),
]);
export type ChatEvent = z.infer<typeof chatEventSchema>;
