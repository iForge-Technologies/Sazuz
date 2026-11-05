import { defaultSettings } from '@sazuz/config/settings';
import { SecretRedactor } from '@sazuz/vault';
import type { ModelInfo } from './contracts.js';
import { defaultModelInfo, type ProviderConfig, type ProviderFetch } from './providers.js';
import { ModelRouter, type ModelRouterOptions, type RouterSettings } from './router.js';

export const fixtureReference = 'secret://sec_01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const fixtureKey = 'sk-fixture-canary-not-a-real-key-12345678';

export function provider(kind: ProviderConfig['kind'], id: string = kind): ProviderConfig {
  return {
    id,
    kind,
    name: id,
    baseUrl: `https://${id}.example.test`,
    secretRef: kind === 'ollama' ? null : fixtureReference,
    locality: kind === 'ollama' ? 'local' : 'cloud',
    enabled: true,
  };
}

export function model(source: ProviderConfig, id = 'fixture-model'): ModelInfo {
  return {
    ...defaultModelInfo(source, id),
    contextWindow: 128_000,
    maxOutput: 8192,
    supports: { tools: true, vision: true, json: true, reasoning: false, caching: true },
    price:
      source.locality === 'local'
        ? { inputPerMTok: 0, outputPerMTok: 0 }
        : { inputPerMTok: 2, outputPerMTok: 8, cachedInputPerMTok: 0.5 },
  };
}

export interface CapturedRequest {
  url: URL;
  headers: Headers;
  body: unknown;
  init: RequestInit | undefined;
}

export function harness(
  providers: ProviderConfig[],
  handler: (request: CapturedRequest) => Response | Promise<Response>,
  options: Partial<ModelRouterOptions> = {},
) {
  const models = providers.map((item) => model(item));
  const settings: RouterSettings = {
    providers: { items: providers },
    models: structuredClone(defaultSettings.models),
  };
  settings.models.roles.executor = models[0]
    ? { providerId: models[0].providerId, modelId: models[0].id }
    : null;
  const requests: CapturedRequest[] = [];
  const redactor = new SecretRedactor();
  const fetcher: ProviderFetch = async (input, init) => {
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const entry = {
      url: new URL(input instanceof Request ? input.url : input.toString()),
      headers: new Headers(init?.headers),
      body,
      init,
    };
    requests.push(entry);
    return handler(entry);
  };
  const router = new ModelRouter({
    getSettings: () => settings,
    getCatalog: () => models,
    resolveSecret: (_reference, consume) => consume(fixtureKey),
    fetch: fetcher,
    redactor,
    ...options,
  });
  return { router, settings, models, requests, redactor };
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function sse(events: unknown[], done = true): Response {
  const text =
    events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') +
    (done ? 'data: [DONE]\n\n' : '');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

export function openaiText(parts = ['Hello ', 'world.'], reportedUsage = true): unknown[] {
  return [
    ...parts.map((content) => ({
      id: 'chatcmpl-fixture',
      model: 'fixture-model',
      created: 1_700_000_000,
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
    })),
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      ...(reportedUsage
        ? {
            usage: {
              prompt_tokens: 100,
              completion_tokens: 10,
              total_tokens: 110,
              prompt_tokens_details: { cached_tokens: 20 },
            },
          }
        : {}),
    },
  ];
}

export function anthropicText(): unknown[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_fixture',
        model: 'claude-sonnet-4-5',
        role: 'assistant',
        content: [],
        type: 'message',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 80,
          output_tokens: 0,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 0,
        },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world.' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 10 },
    },
    { type: 'message_stop' },
  ];
}

export function googleText(): unknown[] {
  return [
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Hello ' }] } }] },
    {
      candidates: [
        { content: { role: 'model', parts: [{ text: 'world.' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 10,
        totalTokenCount: 110,
        cachedContentTokenCount: 20,
      },
    },
  ];
}
