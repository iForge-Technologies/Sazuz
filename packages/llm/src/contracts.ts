import { z } from 'zod';

const identifier = z.string().trim().min(1).max(200);
const providerId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const nonnegative = z.number().finite().nonnegative();

export const modelPriceSchema = z.strictObject({
  inputPerMTok: nonnegative.max(1_000_000),
  outputPerMTok: nonnegative.max(1_000_000),
  cachedInputPerMTok: nonnegative.max(1_000_000).optional(),
});
export type ModelPrice = z.infer<typeof modelPriceSchema>;

export const modelInfoSchema = z.strictObject({
  id: identifier,
  providerId,
  name: z.string().trim().min(1).max(240),
  contextWindow: z.number().int().min(1).max(10_000_000),
  maxOutput: z.number().int().min(1).max(1_000_000),
  supports: z.strictObject({
    tools: z.boolean(),
    vision: z.boolean(),
    json: z.boolean(),
    caching: z.boolean(),
    reasoning: z.boolean(),
  }),
  // Unknown prices are deliberately distinct from free models.
  price: modelPriceSchema.nullable(),
  locality: z.enum(['cloud', 'local']),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;
export const modelCatalogSchema = z.array(modelInfoSchema).max(5000);

export const modelRoleSchema = z.enum(['planner', 'executor', 'fast', 'vision']);
export type ModelRole = z.infer<typeof modelRoleSchema>;

export const llmToolCallSchema = z.strictObject({
  id: z.string().min(1).max(240),
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
  args: z.unknown(),
});
export type LlmToolCall = z.infer<typeof llmToolCallSchema>;

export const llmImageSchema = z.strictObject({
  mimeType: z.literal('image/jpeg'),
  data: z
    .string()
    .min(4)
    .max(2000000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type LlmImage = z.infer<typeof llmImageSchema>;

export const llmMessageSchema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('system'), content: z.string().max(1_000_000) }),
  z.strictObject({
    role: z.literal('user'),
    content: z.string().max(1_000_000),
    images: z.array(llmImageSchema).min(1).max(1).optional(),
  }),
  z.strictObject({
    role: z.literal('assistant'),
    content: z.string().max(1_000_000),
    toolCalls: z.array(llmToolCallSchema).max(128).optional(),
  }),
  z.strictObject({
    role: z.literal('tool'),
    toolCallId: z.string().min(1).max(240),
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
    content: z.string().max(1_000_000),
  }),
]);
export type LlmMessage = z.infer<typeof llmMessageSchema>;

export const llmToolSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
  description: z.string().min(1).max(4000),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type LlmTool = z.infer<typeof llmToolSchema>;

export const tokenUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  source: z.enum(['provider', 'estimated']),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export const generationUsageRecordSchema = z.strictObject({
  providerId,
  modelId: identifier,
  usage: tokenUsageSchema,
  costUsd: nonnegative,
  costEstimated: z.boolean(),
  latencyMs: nonnegative,
  status: z.enum(['completed', 'failed']),
});
export type GenerationUsageRecord = z.infer<typeof generationUsageRecordSchema>;

export const generateResultSchema = generationUsageRecordSchema.omit({ status: true }).extend({
  text: z.string().max(1_000_000),
  toolCalls: z.array(llmToolCallSchema).max(128),
  finishReason: z.enum(['stop', 'length', 'tool-calls', 'content-filter', 'other']),
});
export type GenerateResult = z.infer<typeof generateResultSchema>;

export const providerHealthSchema = z.strictObject({
  providerId,
  ok: z.boolean(),
  latencyMs: nonnegative,
  modelCount: z.number().int().nonnegative(),
  code: z
    .enum([
      'READY',
      'PROVIDER_DISABLED',
      'PROVIDER_NOT_FOUND',
      'PROVIDER_AUTH',
      'PROVIDER_RATE_LIMIT',
      'PROVIDER_UNAVAILABLE',
      'PROVIDER_INVALID_RESPONSE',
      'VAULT_UNAVAILABLE',
      'ABORTED',
    ])
    .nullable(),
});
export type ProviderHealth = z.infer<typeof providerHealthSchema>;

export const generationInputSchema = z.strictObject({
  messages: z.array(llmMessageSchema).min(1).max(1000),
  tools: z
    .array(llmToolSchema)
    .max(128)
    .refine((items) => new Set(items.map((item) => item.name)).size === items.length)
    .default([]),
  role: modelRoleSchema.default('executor'),
  selectedModel: z.strictObject({ providerId, modelId: identifier }).optional(),
  preset: z.enum(['quality', 'balanced', 'budget', 'private']).optional(),
  privateOnly: z.boolean().default(false),
  remainingBudgetUsd: nonnegative.max(1_000_000),
  maxOutputTokens: z.number().int().min(1).max(1_000_000).default(1024),
  requireJson: z.boolean().default(false),
  responseSchema: z.record(z.string(), z.unknown()).optional(),
});

export interface GenerateRequest extends z.input<typeof generationInputSchema> {
  signal?: AbortSignal;
  onToken?: (text: string) => Promise<void> | void;
  onUsage?: (record: GenerationUsageRecord) => Promise<void> | void;
}

export const modelTestInputSchema = z.strictObject({
  providerId,
  modelId: identifier,
  remainingBudgetUsd: nonnegative.max(1_000_000),
});

export interface ModelTestRequest {
  remainingBudgetUsd: number;
  signal?: AbortSignal;
  onUsage?: (record: GenerationUsageRecord) => Promise<void> | void;
}
