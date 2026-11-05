import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { GenerationUsageRecord } from './contracts.js';
import { wireToolName } from './stream.js';
import {
  anthropicText,
  fixtureKey,
  fixtureReference,
  googleText,
  harness,
  json,
  openaiText,
  provider,
  sse,
} from './test-fixtures.js';

const request = {
  messages: [{ role: 'user' as const, content: 'Say hello.' }],
  remainingBudgetUsd: 1,
};

describe('AI SDK wire adapters', () => {
  it.each([
    {
      kind: 'openai' as const,
      modelId: 'gpt-4o',
      events: openaiText,
      path: '/v1/chat/completions',
      header: 'authorization',
      key: `Bearer ${fixtureKey}`,
    },
    {
      kind: 'anthropic' as const,
      modelId: 'claude-sonnet-4-5',
      events: anthropicText,
      path: '/v1/messages',
      header: 'x-api-key',
      key: fixtureKey,
    },
    {
      kind: 'google' as const,
      modelId: 'gemini-2.5-flash',
      events: googleText,
      path: '/v1beta/models/gemini-2.5-flash:streamGenerateContent',
      header: 'x-goog-api-key',
      key: fixtureKey,
    },
    {
      kind: 'ollama' as const,
      modelId: 'llama3.2:3b',
      events: openaiText,
      path: '/v1/chat/completions',
      header: 'authorization',
      key: null,
    },
  ])(
    'streams a real $kind protocol and accounts provider usage without resolving keys early',
    async (fixture) => {
      let resolving = false;
      let calls = 0;
      const source = provider(fixture.kind);
      const { router, models, settings, requests } = harness(
        [source],
        () => {
          expect(resolving).toBe(source.secretRef !== null);
          return sse(fixture.events(), fixture.kind === 'openai' || fixture.kind === 'ollama');
        },
        {
          resolveSecret: async (reference, consume) => {
            expect(reference).toBe(fixtureReference);
            calls += 1;
            resolving = true;
            try {
              return await consume(fixtureKey);
            } finally {
              resolving = false;
            }
          },
        },
      );
      models[0]!.id = fixture.modelId;
      settings.models.roles.executor!.modelId = fixture.modelId;
      const tokens: string[] = [];
      const usage: GenerationUsageRecord[] = [];
      const result = await router.generate({
        ...request,
        onToken: (token) => {
          tokens.push(token);
        },
        onUsage: (record) => {
          usage.push(record);
        },
      });
      expect(result.text).toBe('Hello world.');
      expect(tokens.join('')).toBe(result.text);
      expect(tokens.length).toBeGreaterThan(1);
      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 20,
        source: 'provider',
      });
      expect(result.costUsd).toBeCloseTo(source.locality === 'local' ? 0 : 0.00025, 10);
      expect(result.costEstimated).toBe(false);
      expect(usage).toHaveLength(1);
      expect(usage[0]?.status).toBe('completed');
      expect(requests[0]?.url.pathname).toBe(fixture.path);
      expect(requests[0]?.headers.get(fixture.header)).toBe(fixture.key);
      expect(requests[0]?.init?.redirect).toBe('error');
      expect(resolving).toBe(false);
      expect(calls).toBe(source.secretRef ? 1 : 0);
      expect(JSON.stringify(result)).not.toContain(fixtureKey);
    },
  );

  it('round-trips dotted tool names and observations through official Chat Completions', async () => {
    const wire = wireToolName('files.read');
    let turn = 0;
    const { router, requests } = harness([provider('openai')], () => {
      turn += 1;
      if (turn > 1) return sse(openaiText(['Read the file.']));
      return sse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_read',
                    type: 'function',
                    function: { name: wire, arguments: '{"path":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '"notes.txt"}' } }] },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 30, completion_tokens: 6 },
        },
      ]);
    });
    const tools = [
      {
        name: 'files.read',
        description: 'Read a project file.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
    ];
    const result = await router.generate({ ...request, tools });
    expect(result.toolCalls).toEqual([
      { id: 'call_read', name: 'files.read', args: { path: 'notes.txt' } },
    ]);
    expect(wire).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(wireToolName('files_read')).not.toBe(wire);
    const posted = z
      .object({ tools: z.array(z.object({ function: z.object({ name: z.string() }) })) })
      .parse(requests[0]?.body);
    expect(posted.tools[0]?.function.name).toBe(wire);
    const next = await router.generate({
      ...request,
      tools,
      messages: [
        ...request.messages,
        { role: 'assistant', content: result.text, toolCalls: result.toolCalls },
        {
          role: 'tool',
          toolCallId: 'call_read',
          name: 'files.read',
          content: '<untrusted>File contents</untrusted>',
        },
      ],
    });
    expect(next.text).toBe('Read the file.');
    const history = z
      .object({ messages: z.array(z.record(z.string(), z.unknown())) })
      .parse(requests[1]?.body);
    expect(history.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_read',
      content: '<untrusted>File contents</untrusted>',
    });
  });

  it('discovers local Ollama models using tags/show and reports their actual capabilities', async () => {
    const { router, requests } = harness([provider('ollama')], (incoming) => {
      if (incoming.url.pathname === '/api/tags')
        return json({ models: [{ name: 'llama3.2:3b' }, { name: 'nomic-embed-text:latest' }] });
      if (incoming.url.pathname === '/api/show') {
        const modelName = z.object({ model: z.string() }).parse(incoming.body).model;
        return modelName.startsWith('nomic')
          ? json({ capabilities: ['embedding'] })
          : json({
              capabilities: ['completion', 'tools'],
              model_info: { 'llama.context_length': 131072 },
            });
      }
      throw new Error('Unexpected fixture route');
    });
    const models = await router.discover('ollama');
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'llama3.2:3b',
      contextWindow: 131072,
      locality: 'local',
      supports: { tools: true, vision: false },
      price: { inputPerMTok: 0, outputPerMTok: 0 },
    });
    expect(requests.map((entry) => entry.url.pathname)).toEqual([
      '/api/tags',
      '/api/show',
      '/api/show',
    ]);
    expect((await router.health('ollama')).ok).toBe(true);
  });

  it('discovers OpenAI, Anthropic pagination and Google metadata without inventing prices', async () => {
    const sources = [provider('openai'), provider('anthropic'), provider('google')];
    const { router, requests } = harness(sources, (incoming) => {
      if (incoming.url.hostname.startsWith('openai'))
        return json({ data: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-small' }] });
      if (incoming.url.hostname.startsWith('anthropic'))
        return incoming.url.searchParams.has('after_id')
          ? json({
              data: [{ id: 'claude-haiku-4-5', display_name: 'Claude Haiku' }],
              has_more: false,
            })
          : json({
              data: [{ id: 'claude-sonnet-4-5' }],
              has_more: true,
              last_id: 'claude-sonnet-4-5',
            });
      return json({
        models: [
          {
            name: 'models/gemini-2.5-flash',
            displayName: 'Gemini Flash',
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      });
    });
    expect(await router.discover('openai')).toMatchObject([{ id: 'gpt-4o', price: null }]);
    expect((await router.discover('anthropic')).map((entry) => entry.id)).toEqual([
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
    ]);
    expect(await router.discover('google')).toMatchObject([
      { id: 'gemini-2.5-flash', contextWindow: 1048576, maxOutput: 65536, price: null },
    ]);
    expect(requests.every((entry) => !entry.url.searchParams.has('key'))).toBe(true);
  });

  it('estimates missing usage and scrubs a secret split across streamed chunks and prompts', async () => {
    const { router, requests } = harness([provider('openai-compatible')], () =>
      sse(openaiText(['Before ', fixtureKey.slice(0, 15), fixtureKey.slice(15), ' after.'], false)),
    );
    const chunks: string[] = [];
    const result = await router.generate({
      ...request,
      messages: [{ role: 'user', content: `Never repeat ${fixtureKey}` }],
      onToken: (token) => {
        chunks.push(token);
      },
    });
    expect(result.text).toBe('Before [REDACTED] after.');
    expect(chunks.join('')).toBe(result.text);
    expect(JSON.stringify(requests[0]?.body)).not.toContain(fixtureKey);
    expect(result.usage.source).toBe('estimated');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.costEstimated).toBe(true);
  });
});
