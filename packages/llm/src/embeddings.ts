import { embedMany } from 'ai';
import { z } from 'zod';
import type { ModelRouterOptions } from './router.js';
import type { GenerationUsageRecord } from './contracts.js';
import { createProviderEmbedding, restrictedProviderFetch } from './providers.js';
import { ModelError } from './errors.js';
import { secretRedactor } from '@sazuz/vault';
import { settingsSchemas } from '@sazuz/config/settings';

export const embeddingRequestSchema = z.strictObject({
  providerId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  modelId: z.string().min(1).max(200),
  texts: z.array(z.string().min(1).max(12000)).min(1).max(32),
  privateOnly: z.boolean(),
  remainingBudgetUsd: z.number().finite().nonnegative(),
});
export const embeddingVectorsSchema = z
  .array(
    z
      .array(z.number().finite())
      .min(1)
      .max(4096)
      .refine((value) => value.some((part) => part !== 0)),
  )
  .min(1)
  .max(32);
export interface EmbeddingRequest extends z.infer<typeof embeddingRequestSchema> {
  signal?: AbortSignal;
  onUsage?: (record: GenerationUsageRecord) => Promise<void> | void;
}
export interface EmbeddingResult {
  vectors: number[][];
  providerId: string;
  modelId: string;
  dimensions: number;
  costUsd: number;
}

export async function embedTexts(
  options: ModelRouterOptions,
  request: EmbeddingRequest,
): Promise<EmbeddingResult> {
  const { signal: suppliedSignal, onUsage, ...input } = request;
  const parsed = embeddingRequestSchema.safeParse(input);
  if (!parsed.success) throw new ModelError('MODEL_INVALID_INPUT');
  const value = parsed.data;
  const settings = await options.getSettings();
  const providers = settingsSchemas.providers.parse(settings.providers);
  const models = settingsSchemas.models.parse(settings.models);
  const provider = providers.items.find((entry) => entry.id === value.providerId && entry.enabled);
  if (
    !provider ||
    ((value.privateOnly || models.preset === 'private') && provider.locality !== 'local')
  )
    throw new ModelError('MODEL_NOT_AVAILABLE');
  const redactor = options.redactor ?? secretRedactor;
  if (value.texts.some((text) => redactor.redactText(text) !== text))
    throw new ModelError('MODEL_INVALID_INPUT');
  const override = models.priceOverrides.find(
    (entry) => entry.providerId === provider.id && entry.modelId === value.modelId,
  );
  const catalog = await options.getCatalog();
  const price =
    override?.price.inputPerMTok ??
    (provider.locality === 'local'
      ? 0
      : catalog.find((entry) => entry.providerId === provider.id && entry.id === value.modelId)
          ?.price?.inputPerMTok);
  if (price === undefined) throw new ModelError('MODEL_PRICE_REQUIRED');
  const bytes = value.texts.reduce(
    (total, text) => total + Buffer.byteLength(text, 'utf8') + 16,
    32,
  );
  if ((bytes * price) / 1_000_000 > value.remainingBudgetUsd)
    throw new ModelError('MODEL_BUDGET_EXCEEDED');
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 60_000),
    ...(suppliedSignal ? [suppliedSignal] : []),
  ]);
  const started = Date.now();
  if (options.admitProvider && !(await options.admitProvider(provider.id)))
    throw new ModelError('PROVIDER_RATE_LIMIT', true);
  let called = false;
  let recorded = false;
  const record = async (tokens: number, estimated: boolean, status: 'completed' | 'failed') => {
    const costUsd = (tokens * price) / 1_000_000;
    recorded = true;
    await onUsage?.({
      providerId: provider.id,
      modelId: value.modelId,
      usage: {
        inputTokens: tokens,
        outputTokens: 0,
        cachedInputTokens: 0,
        source: estimated ? 'estimated' : 'provider',
      },
      costUsd,
      costEstimated: estimated,
      latencyMs: Date.now() - started,
      status,
    });
    return costUsd;
  };
  const run = async (key: string | undefined) => {
    if (key) redactor.register(key);
    // A newly resolved credential must also be checked against the submitted texts.
    if (value.texts.some((text) => redactor.redactText(text) !== text))
      throw new ModelError('MODEL_INVALID_INPUT');
    const model = createProviderEmbedding(
      provider,
      value.modelId,
      key,
      restrictedProviderFetch(options.fetch ?? fetch, new URL(provider.baseUrl).origin),
    );
    called = true;
    const response = await embedMany({
      model,
      values: value.texts,
      maxRetries: 0,
      maxParallelCalls: 1,
      abortSignal: signal,
    });
    const reported = Number.isSafeInteger(response.usage.tokens) && response.usage.tokens >= 0;
    const parsedVectors = embeddingVectorsSchema.safeParse(response.embeddings);
    const valid =
      parsedVectors.success &&
      parsedVectors.data.length === value.texts.length &&
      parsedVectors.data.every((vector) => vector.length === parsedVectors.data[0]!.length);
    const costUsd = await record(
      reported ? response.usage.tokens : Math.ceil(bytes / 3),
      !reported,
      valid ? 'completed' : 'failed',
    );
    if (!parsedVectors.success || !valid) throw new ModelError('PROVIDER_INVALID_RESPONSE');
    const vectors = parsedVectors.data;
    const dimensions = vectors[0]!.length;
    return { vectors, dimensions, providerId: provider.id, modelId: value.modelId, costUsd };
  };
  try {
    return provider.secretRef
      ? await options.resolveSecret(provider.secretRef, run)
      : await run(undefined);
  } catch (error) {
    if (called && !recorded) await record(Math.ceil(bytes / 3), true, 'failed');
    if (error instanceof ModelError) throw error;
    throw new ModelError('PROVIDER_INVALID_RESPONSE');
  }
}
