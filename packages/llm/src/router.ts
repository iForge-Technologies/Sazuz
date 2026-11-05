import { settingsSchemas, type SettingsValues } from '@sazuz/config/settings';
import { secretRedactor, type SecretRedactor } from '@sazuz/vault';
import { z } from 'zod';
import {
  generateResultSchema,
  generationInputSchema,
  generationUsageRecordSchema,
  llmMessageSchema,
  modelCatalogSchema,
  modelTestInputSchema,
  providerHealthSchema,
  type GenerateRequest,
  type GenerateResult,
  type GenerationUsageRecord,
  type ModelInfo,
  type ModelPrice,
  type ModelTestRequest,
  type ProviderHealth,
} from './contracts.js';
import { ModelError, safeProviderError } from './errors.js';
import {
  discoverProviderModels,
  restrictedProviderFetch,
  type ProviderConfig,
  type ProviderFetch,
} from './providers.js';
import { CircuitBreaker, ProviderRateLimiter } from './resilience.js';
import { streamProviderAttempt } from './stream.js';
import { calculateCost, inputTokenBound, maximumCost } from './usage.js';
import { embedTexts, type EmbeddingRequest } from './embeddings.js';

export interface RouterSettings {
  providers: SettingsValues['providers'];
  models: SettingsValues['models'];
}
/** User-supplied metadata is scoped to one model and never changes provider authority. */
export function configuredModel(model: ModelInfo, settings: SettingsValues['models']): ModelInfo {
  const limits = settings.modelLimits.find(
    (value) => value.providerId === model.providerId && value.modelId === model.id,
  );
  const price = settings.priceOverrides.find(
    (value) => value.providerId === model.providerId && value.modelId === model.id,
  );
  return {
    ...model,
    ...(limits ? { contextWindow: limits.contextWindow, maxOutput: limits.maxOutput } : {}),
    ...(price ? { price: price.price } : {}),
  };
}
export interface ModelRouterOptions {
  getSettings: () => RouterSettings | Promise<RouterSettings>;
  getCatalog: () => ModelInfo[] | Promise<ModelInfo[]>;
  resolveSecret: <T>(reference: string, consume: (value: string) => Promise<T>) => Promise<T>;
  fetch?: ProviderFetch;
  redactor?: SecretRedactor;
  now?: () => number;
  timeoutMs?: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
  requestsPerMinute?: number;
  requestBurst?: number;
  /** Uses shared configured capacity instead of the router's process-local rate limiter. */
  admitProvider?: (providerId: string) => Promise<boolean>;
}

const settingsSchema = z.strictObject({
  providers: settingsSchemas.providers,
  models: settingsSchemas.models,
});
const limitsSchema = z.strictObject({
  timeoutMs: z.number().int().min(1).max(600_000),
  circuitFailureThreshold: z.number().int().min(1).max(100),
  circuitCooldownMs: z.number().int().min(1).max(3_600_000),
  requestsPerMinute: z.number().positive().max(100_000),
  requestBurst: z.number().int().min(1).max(100_000),
});
type ParsedRequest = z.output<typeof generationInputSchema>;
interface Candidate {
  provider: ProviderConfig;
  model: ModelInfo;
  price: ModelPrice;
  maxOutputTokens: number;
  score: number;
}

export class ModelRouter {
  embed(request: EmbeddingRequest) {
    return embedTexts(this.options, request);
  }
  readonly #redactor: SecretRedactor;
  readonly #now: () => number;
  readonly #fetch: ProviderFetch;
  readonly #timeoutMs: number;
  readonly #circuit: CircuitBreaker;
  readonly #rates: ProviderRateLimiter;
  readonly #latencies = new Map<string, number[]>();

  constructor(readonly options: ModelRouterOptions) {
    const limits = limitsSchema.safeParse({
      timeoutMs: options.timeoutMs ?? 60_000,
      circuitFailureThreshold: options.circuitFailureThreshold ?? 3,
      circuitCooldownMs: options.circuitCooldownMs ?? 30_000,
      requestsPerMinute: options.requestsPerMinute ?? 60,
      requestBurst: options.requestBurst ?? 10,
    });
    if (!limits.success) throw new ModelError('MODEL_INVALID_INPUT');
    this.#redactor = options.redactor ?? secretRedactor;
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = limits.data.timeoutMs;
    this.#circuit = new CircuitBreaker(
      this.#now,
      limits.data.circuitFailureThreshold,
      limits.data.circuitCooldownMs,
    );
    this.#rates = new ProviderRateLimiter(
      this.#now,
      limits.data.requestsPerMinute,
      limits.data.requestBurst,
    );
  }

  async #settings(): Promise<RouterSettings> {
    let value: unknown;
    try {
      value = await this.options.getSettings();
    } catch {
      throw new ModelError('MODEL_NOT_AVAILABLE');
    }
    const parsed = settingsSchema.safeParse(value);
    if (!parsed.success) throw new ModelError('MODEL_INVALID_INPUT');
    return parsed.data;
  }

  async #provider(id: string): Promise<ProviderConfig> {
    const settings = await this.#settings();
    const provider = settings.providers.items.find((item) => item.id === id);
    if (!provider) throw new ModelError('PROVIDER_NOT_FOUND');
    if (!provider.enabled) throw new ModelError('PROVIDER_DISABLED');
    return provider;
  }

  async #withCredential<T>(
    provider: ProviderConfig,
    consume: (key: string | undefined) => Promise<T>,
  ): Promise<T> {
    if (!provider.secretRef) {
      if (
        provider.locality === 'cloud' &&
        ['openai', 'anthropic', 'google'].includes(provider.kind)
      )
        throw new ModelError('PROVIDER_AUTH');
      return consume(undefined);
    }
    try {
      return await this.options.resolveSecret(provider.secretRef, async (key) => {
        if (!key || key.length > 65_536) throw new ModelError('VAULT_UNAVAILABLE');
        this.#redactor.register(key);
        return consume(key);
      });
    } catch (error) {
      if (error instanceof ModelError) throw error;
      throw new ModelError('VAULT_UNAVAILABLE');
    }
  }

  async discover(providerId: string, signal?: AbortSignal): Promise<ModelInfo[]> {
    if (signal?.aborted) throw new ModelError('ABORTED');
    const provider = await this.#provider(providerId);
    const abortSignal = AbortSignal.any([
      AbortSignal.timeout(this.#timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    try {
      const models = await this.#withCredential(provider, (key) =>
        discoverProviderModels(
          provider,
          key,
          restrictedProviderFetch(this.#fetch, new URL(provider.baseUrl).origin),
          abortSignal,
        ),
      );
      const parsed = modelCatalogSchema.safeParse(this.#redactor.redact(models));
      if (!parsed.success) throw new ModelError('PROVIDER_INVALID_RESPONSE');
      this.#circuit.success(providerId);
      return parsed.data;
    } catch (error) {
      throw safeProviderError(error, signal?.aborted);
    }
  }

  async health(providerId: string, signal?: AbortSignal): Promise<ProviderHealth> {
    const started = this.#now();
    try {
      const models = await this.discover(providerId, signal);
      return providerHealthSchema.parse({
        providerId,
        ok: true,
        latencyMs: Math.max(0, this.#now() - started),
        modelCount: models.length,
        code: 'READY',
      });
    } catch (error) {
      const failure = safeProviderError(error, signal?.aborted);
      const parsedCode = providerHealthSchema.shape.code.safeParse(failure.code);
      const result = providerHealthSchema.safeParse({
        providerId,
        ok: false,
        latencyMs: Math.max(0, this.#now() - started),
        modelCount: 0,
        code: parsedCode.success ? parsedCode.data : 'PROVIDER_UNAVAILABLE',
      });
      if (!result.success) throw new ModelError('MODEL_INVALID_INPUT');
      return result.data;
    }
  }

  #latency(model: ModelInfo): number {
    const values = this.#latencies.get(`${model.providerId}:${model.id}`);
    if (!values?.length) return 1000;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }

  #candidates(settings: RouterSettings, catalog: ModelInfo[], request: ParsedRequest): Candidate[] {
    const bound = inputTokenBound(request.messages, request.tools);
    const assignment = settings.models.roles[request.role];
    let priceMissing = false;
    let contextExceeded = false;
    let budgetExceeded = false;
    const candidates: Candidate[] = [];
    for (const entry of catalog) {
      const provider = settings.providers.items.find(
        (item) => item.id === entry.providerId && item.enabled,
      );
      if (!provider) continue;
      if (
        (request.privateOnly || settings.models.preset === 'private') &&
        provider.locality !== 'local'
      )
        continue;
      if (request.tools.length && !entry.supports.tools) continue;
      if (
        (request.role === 'vision' ||
          request.messages.some((message) => message.role === 'user' && message.images?.length)) &&
        !entry.supports.vision
      )
        continue;
      if (request.requireJson && !entry.supports.json) continue;
      const model = { ...configuredModel(entry, settings.models), locality: provider.locality };
      const maxOutputTokens = Math.min(request.maxOutputTokens, model.maxOutput);
      if (bound + maxOutputTokens > model.contextWindow) {
        contextExceeded = true;
        continue;
      }
      const price =
        model.price ??
        (provider.locality === 'local' ? { inputPerMTok: 0, outputPerMTok: 0 } : null);
      if (!price) {
        priceMissing = true;
        continue;
      }
      const estimatedCost = maximumCost(price, bound, maxOutputTokens);
      if (estimatedCost > request.remainingBudgetUsd) {
        budgetExceeded = true;
        continue;
      }
      const explicit = assignment?.providerId === provider.id && assignment.modelId === model.id;
      const fallback = settings.models.fallbackOrder.indexOf(provider.id);
      const preset = settings.models.preset;
      const quality =
        Math.log2(model.contextWindow) +
        (model.supports.reasoning ? 3 : 0) +
        (model.supports.tools ? 2 : 0);
      const costWeight =
        preset === 'budget' || request.role === 'fast' ? 100_000 : preset === 'quality' ? 10 : 1000;
      const score =
        (explicit ? 1_000_000 : 0) +
        (fallback >= 0 ? 10_000 - fallback * 100 : 0) +
        quality * (preset === 'quality' ? 10 : 1) -
        estimatedCost * costWeight -
        this.#latency(model) / 1000;
      candidates.push({ provider, model, maxOutputTokens, price, score });
    }
    if (!candidates.length) {
      if (budgetExceeded) throw new ModelError('MODEL_BUDGET_EXCEEDED');
      if (priceMissing) throw new ModelError('MODEL_PRICE_REQUIRED');
      if (contextExceeded) throw new ModelError('MODEL_CONTEXT_EXCEEDED');
      throw new ModelError('MODEL_NOT_AVAILABLE');
    }
    return candidates.sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));
  }

  generate(request: GenerateRequest): Promise<GenerateResult> {
    return this.#generate(request);
  }

  /** A billable inference probe of one exact model, without routed fallbacks or user content. */
  async testModel(
    providerId: string,
    modelId: string,
    request: ModelTestRequest,
  ): Promise<GenerateResult> {
    const parsed = modelTestInputSchema.safeParse({
      providerId,
      modelId,
      remainingBudgetUsd: request.remainingBudgetUsd,
    });
    if (!parsed.success) throw new ModelError('MODEL_INVALID_INPUT');
    if (request.signal?.aborted) throw new ModelError('ABORTED');
    await this.#provider(parsed.data.providerId);
    const result = await this.#generate(
      {
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        tools: [],
        maxOutputTokens: 16,
        remainingBudgetUsd: parsed.data.remainingBudgetUsd,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.onUsage ? { onUsage: request.onUsage } : {}),
      },
      { providerId: parsed.data.providerId, modelId: parsed.data.modelId },
    );
    if (!result.text.trim() || result.toolCalls.length)
      throw new ModelError('MODEL_OUTPUT_INVALID');
    return result;
  }

  async #generate(
    request: GenerateRequest,
    selectedModel?: { providerId: string; modelId: string },
  ): Promise<GenerateResult> {
    const { signal, onToken, onUsage, ...input } = request;
    if (signal?.aborted) throw new ModelError('ABORTED');
    const parsed = generationInputSchema.safeParse(input);
    if (!parsed.success) throw new ModelError('MODEL_INVALID_INPUT');
    for (const tool of parsed.data.tools)
      if (!z.json().safeParse(tool.inputSchema).success)
        throw new ModelError('MODEL_INVALID_INPUT');
    if (parsed.data.responseSchema && !z.json().safeParse(parsed.data.responseSchema).success)
      throw new ModelError('MODEL_INVALID_INPUT');
    const messages = z
      .array(llmMessageSchema)
      .safeParse(this.#redactor.redact(parsed.data.messages));
    if (!messages.success) throw new ModelError('MODEL_INVALID_INPUT');
    parsed.data.messages = messages.data;
    const settings = await this.#settings();
    let catalog: unknown;
    selectedModel ??= parsed.data.selectedModel;
    if (parsed.data.preset) settings.models = { ...settings.models, preset: parsed.data.preset };
    try {
      catalog = await this.options.getCatalog();
    } catch {
      throw new ModelError('MODEL_NOT_AVAILABLE');
    }
    const parsedCatalog = modelCatalogSchema.safeParse(catalog);
    if (!parsedCatalog.success) throw new ModelError('MODEL_INVALID_INPUT');
    const catalogModels = selectedModel
      ? parsedCatalog.data.filter(
          (model) =>
            model.providerId === selectedModel.providerId && model.id === selectedModel.modelId,
        )
      : parsedCatalog.data;
    const candidates = this.#candidates(settings, catalogModels, parsed.data);
    const triedProviders = new Set<string>();
    let spent = 0;
    let failure = new ModelError('MODEL_NOT_AVAILABLE');
    let attempts = 0;
    let cursor = 0;
    let plannerConsidered = false;
    while (attempts < 3) {
      if (signal?.aborted) throw new ModelError('ABORTED');
      let candidate: Candidate | undefined;
      let plannerRetry = false;
      // After two failures, use the eligible Planner once, even when a different model
      // at that provider was already attempted. Every admission check still applies.
      if (attempts === 2 && !plannerConsidered) {
        plannerConsidered = true;
        const planner = settings.models.roles.planner;
        candidate = candidates.find(
          (item) => item.provider.id === planner?.providerId && item.model.id === planner.modelId,
        );
        plannerRetry = candidate !== undefined;
      }
      candidate ??= candidates[cursor++];
      if (!candidate) break;
      if (triedProviders.has(candidate.provider.id) && !plannerRetry) continue;
      if (
        maximumCost(
          candidate.price,
          inputTokenBound(parsed.data.messages, parsed.data.tools),
          candidate.maxOutputTokens,
        ) >
        parsed.data.remainingBudgetUsd - spent
      ) {
        failure = new ModelError('MODEL_BUDGET_EXCEEDED');
        continue;
      }
      if (!this.#circuit.acquire(candidate.provider.id)) {
        failure = new ModelError('PROVIDER_UNAVAILABLE', true);
        continue;
      }
      let providerAdmitted: boolean;
      try {
        providerAdmitted = this.options.admitProvider
          ? await this.options.admitProvider(candidate.provider.id)
          : this.#rates.acquire(candidate.provider.id);
      } catch {
        this.#circuit.release(candidate.provider.id);
        throw new ModelError('PROVIDER_UNAVAILABLE', true);
      }
      if (!providerAdmitted) {
        this.#circuit.release(candidate.provider.id);
        failure = new ModelError('PROVIDER_RATE_LIMIT', true);
        continue;
      }
      triedProviders.add(candidate.provider.id);
      attempts += 1;
      const started = this.#now();
      const effectiveSignal = AbortSignal.any([
        AbortSignal.timeout(this.#timeoutMs),
        ...(signal ? [signal] : []),
      ]);
      let attempt;
      try {
        attempt = await this.#withCredential(candidate.provider, (key) =>
          streamProviderAttempt({
            provider: candidate.provider,
            modelId: candidate.model.id,
            key,
            fetcher: restrictedProviderFetch(
              this.#fetch,
              new URL(candidate.provider.baseUrl).origin,
            ),
            messages: parsed.data.messages,
            tools: parsed.data.tools,
            maxOutputTokens: candidate.maxOutputTokens,
            requireJson: parsed.data.requireJson,
            responseSchema: parsed.data.responseSchema,
            signal: effectiveSignal,
            callerSignal: signal,
            redactor: this.#redactor,
            onToken,
          }),
        );
      } catch (error) {
        this.#circuit.release(candidate.provider.id);
        throw safeProviderError(error, signal?.aborted);
      }
      const record = generationUsageRecordSchema.parse({
        providerId: candidate.provider.id,
        modelId: candidate.model.id,
        usage: attempt.usage,
        costUsd: calculateCost(candidate.price, attempt.usage),
        costEstimated: attempt.usage.source === 'estimated',
        latencyMs: Math.max(0, this.#now() - started),
        status: attempt.error ? 'failed' : 'completed',
      });
      spent += record.costUsd;
      try {
        await onUsage?.(record);
      } catch {
        this.#circuit.release(candidate.provider.id);
        throw new ModelError('USAGE_RECORD_FAILED');
      }
      if (attempt.error) {
        failure = attempt.error;
        if (failure.retryable) this.#circuit.failure(candidate.provider.id);
        else this.#circuit.release(candidate.provider.id);
        if (attempt.emitted && failure.code !== 'ABORTED')
          throw new ModelError('MODEL_STREAM_FAILED');
        if (!failure.retryable || signal?.aborted) throw failure;
        continue;
      }
      this.#circuit.success(candidate.provider.id);
      const key = `${candidate.provider.id}:${candidate.model.id}`;
      this.#latencies.set(key, [...(this.#latencies.get(key) ?? []).slice(-19), record.latencyMs]);
      if (spent > parsed.data.remainingBudgetUsd) throw new ModelError('MODEL_BUDGET_EXCEEDED');
      const usageResult = {
        providerId: record.providerId,
        modelId: record.modelId,
        usage: record.usage,
        costUsd: record.costUsd,
        costEstimated: record.costEstimated,
        latencyMs: record.latencyMs,
      };
      return generateResultSchema.parse({
        ...usageResult,
        text: attempt.text,
        toolCalls: attempt.toolCalls,
        finishReason: attempt.finishReason,
      });
    }
    throw failure;
  }

  /** Native JSON mode with at most one optional schema repair, all charged through onUsage. */
  async generateObject<T>(
    request: GenerateRequest,
    schema: z.ZodType<T>,
    options: { maxAttempts?: 1 | 2 } = {},
  ): Promise<GenerateResult & { object: T }> {
    const checkedOptions = z
      .strictObject({ maxAttempts: z.union([z.literal(1), z.literal(2)]).default(2) })
      .safeParse(options);
    if (!checkedOptions.success) throw new ModelError('MODEL_INVALID_INPUT');
    const { maxAttempts } = checkedOptions.data;
    let schemaText: string;
    try {
      schemaText = JSON.stringify(z.toJSONSchema(schema));
    } catch {
      throw new ModelError('MODEL_INVALID_INPUT');
    }
    let spent = 0;
    const onUsage = async (record: GenerationUsageRecord) => {
      spent += record.costUsd;
      await request.onUsage?.(record);
    };
    const base = { ...request };
    delete base.onToken;
    const messages = [
      ...request.messages,
      { role: 'user' as const, content: `Return only JSON matching this schema: ${schemaText}` },
    ];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let result: GenerateResult;
      try {
        result = await this.generate({
          ...base,
          messages,
          tools: [],
          requireJson: true,
          responseSchema: JSON.parse(schemaText) as Record<string, unknown>,
          remainingBudgetUsd: Math.max(0, request.remainingBudgetUsd - spent),
          onUsage,
        });
      } catch (error) {
        if (
          attempt + 1 < maxAttempts &&
          error instanceof ModelError &&
          error.code === 'MODEL_OUTPUT_INVALID'
        ) {
          messages.push({
            role: 'user',
            content:
              'Validation failed: invalid JSON syntax. Return a JSON value matching the supplied schema.',
          });
          continue;
        }
        throw error;
      }
      const parsed = schema.safeParse(JSON.parse(result.text) as unknown);
      if (parsed.success) return { ...result, object: parsed.data };
      if (attempt + 1 < maxAttempts) {
        messages.push({ role: 'assistant', content: result.text });
        const codes = [...new Set(parsed.error.issues.map((issue) => issue.code))].join(', ');
        messages.push({
          role: 'user',
          content: `Schema validation failed (${codes}). Return corrected JSON matching the supplied schema.`,
        });
      }
    }
    throw new ModelError('MODEL_OUTPUT_INVALID');
  }
}
