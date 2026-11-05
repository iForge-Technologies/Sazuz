import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel, EmbeddingModel } from 'ai';
import type { SettingsValues } from '@sazuz/config/settings';
import { z } from 'zod';
import { modelInfoSchema, type ModelInfo } from './contracts.js';
import { ModelError, providerStatusError } from './errors.js';

export type ProviderConfig = SettingsValues['providers']['items'][number];
export type ProviderFetch = typeof globalThis.fetch;

export function providerBaseUrl(provider: ProviderConfig): string {
  const base = provider.baseUrl.replace(/\/+$/, '');
  const url = new URL(base);
  if (provider.kind === 'ollama') return base.replace(/\/(?:v1|api)$/, '') + '/v1';
  if (url.pathname === '' || url.pathname === '/')
    return base + (provider.kind === 'google' ? '/v1beta' : '/v1');
  return base;
}

export function createProviderModel(
  provider: ProviderConfig,
  modelId: string,
  apiKey: string | undefined,
  fetcher: ProviderFetch,
): LanguageModel {
  const baseURL = providerBaseUrl(provider);
  // Explicit keys prevent an SDK from reading provider environment variables.
  const options = { baseURL, apiKey: apiKey ?? '', fetch: fetcher };
  if (provider.kind === 'openai') return createOpenAI(options).chat(modelId);
  if (provider.kind === 'anthropic') return createAnthropic(options)(modelId);
  if (provider.kind === 'google') return createGoogleGenerativeAI(options)(modelId);
  return createOpenAICompatible({
    baseURL,
    fetch: fetcher,
    ...(apiKey === undefined ? {} : { apiKey }),
    name: provider.id,
    includeUsage: true,
    supportsStructuredOutputs: true,
  }).chatModel(modelId);
}

export function restrictedProviderFetch(fetcher: ProviderFetch, origin: string): ProviderFetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== origin) return Promise.reject(new ModelError('PROVIDER_UNAVAILABLE'));
    // Discovery pages and SDK calls must not forward a vault credential through a redirect.
    return fetcher(input, { ...init, redirect: 'error' });
  };
}

/** Embeddings deliberately use one exact provider/model; changing vector spaces requires re-indexing. */
export function createProviderEmbedding(
  provider: ProviderConfig,
  modelId: string,
  apiKey: string | undefined,
  fetcher: ProviderFetch,
): EmbeddingModel {
  const options = { baseURL: providerBaseUrl(provider), apiKey: apiKey ?? '', fetch: fetcher };
  if (provider.kind === 'anthropic') throw new ModelError('MODEL_NOT_AVAILABLE');
  if (provider.kind === 'openai') return createOpenAI(options).embeddingModel(modelId);
  if (provider.kind === 'google') return createGoogleGenerativeAI(options).embeddingModel(modelId);
  return createOpenAICompatible({ ...options, name: provider.id }).embeddingModel(modelId);
}

const namedModel = z.object({
  id: z.string().min(1).max(200),
  display_name: z.string().min(1).max(240).optional(),
});
const standardList = z.object({
  data: z.array(namedModel).max(5000),
  has_more: z.boolean().optional(),
  last_id: z.string().max(200).nullable().optional(),
});
const googleList = z.object({
  models: z
    .array(
      z.object({
        name: z.string().min(1).max(240),
        displayName: z.string().min(1).max(240).optional(),
        inputTokenLimit: z.number().int().positive().optional(),
        outputTokenLimit: z.number().int().positive().optional(),
        supportedGenerationMethods: z.array(z.string()).optional(),
      }),
    )
    .max(5000)
    .default([]),
  nextPageToken: z.string().max(2048).optional(),
});
const ollamaList = z.object({
  models: z.array(z.object({ name: z.string().min(1).max(200) })).max(1000),
});
const ollamaShow = z.object({
  capabilities: z.array(z.string()).max(30).optional(),
  model_info: z.record(z.string(), z.unknown()).optional(),
});

export function defaultModelInfo(provider: ProviderConfig, id: string, name = id): ModelInfo {
  const familiarChat =
    /^(?:gpt-|o[134]-|claude-|gemini-|llama[34](?:[.:]|$)|qwen[23](?:[.:]|$)|mistral|mixtral|deepseek)/i.test(
      id,
    );
  return modelInfoSchema.parse({
    id,
    providerId: provider.id,
    name,
    contextWindow: 8192,
    maxOutput: 2048,
    supports: {
      tools: familiarChat,
      vision: /^(?:gpt-4o|gpt-4\.1|gpt-5|claude-3|claude-(?:sonnet|opus|haiku)-4|gemini-)/i.test(
        id,
      ),
      json: familiarChat,
      caching:
        provider.kind === 'anthropic' || provider.kind === 'openai' || provider.kind === 'google',
      reasoning: /^(?:o[134]-|gpt-5|gemini-2\.5|deepseek-r1)/i.test(id),
    },
    price: provider.locality === 'local' ? { inputPerMTok: 0, outputPerMTok: 0 } : null,
    locality: provider.locality,
  });
}

async function readJson(url: URL, fetcher: ProviderFetch, init: RequestInit): Promise<unknown> {
  const response = await fetcher(url, init);
  if (!response.ok) {
    await response.body?.cancel();
    throw providerStatusError(response.status);
  }
  if (!response.body) throw new ModelError('PROVIDER_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new ModelError('PROVIDER_INVALID_RESPONSE');
      length += value.byteLength;
      if (length > 4_000_000) {
        await reader.cancel();
        throw new ModelError('PROVIDER_INVALID_RESPONSE');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ModelError('PROVIDER_INVALID_RESPONSE');
  } finally {
    reader.releaseLock();
  }
}

/** Official model-list endpoints, with bounded same-origin pagination and response sizes. */
export async function discoverProviderModels(
  provider: ProviderConfig,
  key: string | undefined,
  fetcher: ProviderFetch,
  signal: AbortSignal,
): Promise<ModelInfo[]> {
  const base = providerBaseUrl(provider);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (provider.kind === 'anthropic') {
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider.kind === 'google') {
    if (key) headers['x-goog-api-key'] = key;
  } else if (key) headers['authorization'] = `Bearer ${key}`;
  const init = { headers, signal, redirect: 'error' as const };
  const result: ModelInfo[] = [];

  if (provider.kind === 'ollama') {
    const native = base.replace(/\/v1$/, '');
    const list = ollamaList.safeParse(await readJson(new URL(`${native}/api/tags`), fetcher, init));
    if (!list.success) throw new ModelError('PROVIDER_INVALID_RESPONSE');
    for (let offset = 0; offset < list.data.models.length; offset += 4) {
      const batch = await Promise.all(
        list.data.models.slice(offset, offset + 4).map(async ({ name }) => {
          const show = ollamaShow.safeParse(
            await readJson(new URL(`${native}/api/show`), fetcher, {
              ...init,
              method: 'POST',
              headers: { ...headers, 'content-type': 'application/json' },
              body: JSON.stringify({ model: name }),
            }),
          );
          if (!show.success) throw new ModelError('PROVIDER_INVALID_RESPONSE');
          const model = defaultModelInfo(provider, name);
          const capabilities = show.data.capabilities;
          if (capabilities && !capabilities.includes('completion')) return null;
          if (capabilities) {
            model.supports.tools = capabilities.includes('tools');
            model.supports.vision = capabilities.includes('vision');
            model.supports.reasoning = capabilities.includes('thinking');
            model.supports.json = true;
          }
          const context = Object.entries(show.data.model_info ?? {}).find(([field]) =>
            field.endsWith('.context_length'),
          )?.[1];
          if (
            typeof context === 'number' &&
            Number.isInteger(context) &&
            context > 0 &&
            context <= 10_000_000
          )
            model.contextWindow = context;
          return model;
        }),
      );
      result.push(...batch.filter((model): model is ModelInfo => model !== null));
    }
    return result;
  }

  let cursor: string | undefined;
  for (let page = 0; page < 25; page += 1) {
    const url = new URL(`${base}/models`);
    if (provider.kind === 'google') {
      url.searchParams.set('pageSize', '1000');
      if (cursor) url.searchParams.set('pageToken', cursor);
      const parsed = googleList.safeParse(await readJson(url, fetcher, init));
      if (!parsed.success) throw new ModelError('PROVIDER_INVALID_RESPONSE');
      for (const entry of parsed.data.models) {
        if (
          entry.supportedGenerationMethods &&
          !entry.supportedGenerationMethods.includes('generateContent')
        )
          continue;
        const model = defaultModelInfo(
          provider,
          entry.name.replace(/^models\//, ''),
          entry.displayName,
        );
        model.contextWindow = Math.min(10_000_000, entry.inputTokenLimit ?? model.contextWindow);
        model.maxOutput = Math.min(1_000_000, entry.outputTokenLimit ?? model.maxOutput);
        result.push(model);
      }
      if (!parsed.data.nextPageToken) return result;
      if (parsed.data.nextPageToken === cursor) throw new ModelError('PROVIDER_INVALID_RESPONSE');
      cursor = parsed.data.nextPageToken;
    } else {
      if (provider.kind === 'anthropic') {
        url.searchParams.set('limit', '1000');
        if (cursor) url.searchParams.set('after_id', cursor);
      }
      const parsed = standardList.safeParse(await readJson(url, fetcher, init));
      if (!parsed.success) throw new ModelError('PROVIDER_INVALID_RESPONSE');
      for (const entry of parsed.data.data) {
        if (/(?:embedding|whisper|tts|dall-e|moderation|sora|image|realtime|audio)/i.test(entry.id))
          continue;
        result.push(defaultModelInfo(provider, entry.id, entry.display_name));
      }
      if (!parsed.data.has_more) return result;
      if (provider.kind !== 'anthropic' || !parsed.data.last_id || parsed.data.last_id === cursor)
        throw new ModelError('PROVIDER_INVALID_RESPONSE');
      cursor = parsed.data.last_id;
    }
    if (result.length > 5000) throw new ModelError('PROVIDER_INVALID_RESPONSE');
  }
  throw new ModelError('PROVIDER_INVALID_RESPONSE');
}
