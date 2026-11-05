import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { GenerationUsageRecord } from './contracts.js';
import { ModelError } from './errors.js';
import { harness, json, openaiText, provider, sse } from './test-fixtures.js';

const input = {
  messages: [{ role: 'user' as const, content: 'Reply briefly.' }],
  remainingBudgetUsd: 1,
};

describe('model routing, admission and retries', () => {
  it('pins a replay model without fallback and retains private admission', async () => {
    const { router, models, requests } = harness(
      [provider('openai-compatible', 'first'), provider('openai-compatible', 'second')],
      () => sse(openaiText()),
    );
    const selectedModel = {
      providerId: 'second',
      modelId: models.find((item) => item.providerId === 'second')!.id,
    };
    expect((await router.generate({ ...input, selectedModel })).providerId).toBe('second');
    await expect(
      router.generate({ ...input, selectedModel, privateOnly: true }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_AVAILABLE' });
    await expect(
      router.generate({ ...input, selectedModel: { ...selectedModel, modelId: 'absent' } }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_AVAILABLE' });
    expect(requests).toHaveLength(1);
  });
  it('releases provider admission after a database limiter failure and returns a typed error', async () => {
    const admission = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('private database detail'))
      .mockResolvedValue(true);
    const { router, requests } = harness(
      [provider('openai-compatible', 'primary')],
      () => sse(openaiText()),
      { admitProvider: admission },
    );
    await expect(router.generate(input)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(requests).toHaveLength(0);
    expect((await router.generate(input)).text).toBe('Hello world.');
  });
  it('applies documented model limits without weakening spending, privacy or unrelated model limits', async () => {
    const { router, models, settings, requests } = harness(
      [provider('openai-compatible', 'primary')],
      () => sse(openaiText()),
    );
    models[0]!.contextWindow = 8192;
    const large = { ...input, messages: [{ role: 'user' as const, content: 'x'.repeat(12000) }] };
    await expect(router.generate(large)).rejects.toMatchObject({ code: 'MODEL_CONTEXT_EXCEEDED' });
    settings.models.modelLimits = [
      { providerId: 'primary', modelId: models[0]!.id, contextWindow: 32768, maxOutput: 2048 },
    ];
    expect((await router.generate(large)).text).toBeTruthy();
    await expect(router.generate({ ...large, remainingBudgetUsd: 0 })).rejects.toMatchObject({
      code: 'MODEL_BUDGET_EXCEEDED',
    });
    await expect(router.generate({ ...large, privateOnly: true })).rejects.toMatchObject({
      code: 'MODEL_NOT_AVAILABLE',
    });
    settings.models.modelLimits[0]!.modelId = 'unrelated-model';
    await expect(router.generate(large)).rejects.toMatchObject({ code: 'MODEL_CONTEXT_EXCEEDED' });
    expect(requests).toHaveLength(1);
  });
  it('reloads provider settings and automatically falls back when a primary is disabled mid-conversation', async () => {
    const { router, settings, requests } = harness(
      [provider('openai-compatible', 'primary'), provider('ollama', 'local')],
      () => sse(openaiText()),
    );
    const first = await router.generate(input);
    expect(first.providerId).toBe('primary');
    settings.providers.items[0]!.enabled = false;
    const second = await router.generate({
      ...input,
      messages: [
        ...input.messages,
        { role: 'assistant', content: first.text },
        { role: 'user', content: 'Continue.' },
      ],
    });
    expect(second.providerId).toBe('local');
    expect(requests.map((request) => request.url.hostname)).toEqual([
      'primary.example.test',
      'local.example.test',
    ]);
  });

  it('keeps private data local even during fallback and when catalog locality is stale', async () => {
    const { router, models, settings, requests } = harness(
      [provider('openai-compatible', 'cloud'), provider('ollama', 'local')],
      () => sse(openaiText()),
    );
    models[0]!.locality = 'local';
    settings.models.fallbackOrder = ['cloud', 'local'];
    expect((await router.generate({ ...input, privateOnly: true })).providerId).toBe('local');
    settings.providers.items[1]!.enabled = false;
    await expect(router.generate({ ...input, privateOnly: true })).rejects.toMatchObject({
      code: 'MODEL_NOT_AVAILABLE',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.hostname).toBe('local.example.test');
  });

  it('honors the private preset for requests without a project privacy flag', async () => {
    const { router, settings } = harness(
      [provider('openai-compatible', 'cloud'), provider('ollama', 'local')],
      () => sse(openaiText()),
    );
    settings.models.preset = 'private';
    expect((await router.generate(input)).providerId).toBe('local');
  });

  it('requires explicit cloud prices and enforces estimated input plus maximum output before spending', async () => {
    const { router, models, requests } = harness([provider('openai-compatible')], () =>
      sse(openaiText()),
    );
    const price = models[0]!.price;
    models[0]!.price = null;
    await expect(router.generate(input)).rejects.toMatchObject({ code: 'MODEL_PRICE_REQUIRED' });
    models[0]!.price = price;
    await expect(router.generate({ ...input, remainingBudgetUsd: 0.000001 })).rejects.toMatchObject(
      { code: 'MODEL_BUDGET_EXCEEDED' },
    );
    expect(requests).toHaveLength(0);
  });

  it('allows a free local model at a zero dollar cap and rejects oversized contexts and unsupported tools', async () => {
    const { router, models, requests } = harness([provider('ollama')], () => sse(openaiText()));
    models[0]!.price = null;
    expect((await router.generate({ ...input, remainingBudgetUsd: 0 })).costUsd).toBe(0);
    models[0]!.contextWindow = 100;
    await expect(router.generate(input)).rejects.toMatchObject({ code: 'MODEL_CONTEXT_EXCEEDED' });
    models[0]!.contextWindow = 8192;
    models[0]!.supports.tools = false;
    await expect(
      router.generate({
        ...input,
        tools: [{ name: 'time.now', description: 'Get time.', inputSchema: { type: 'object' } }],
      }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_AVAILABLE' });
    expect(requests).toHaveLength(1);
  });

  it('uses a cheaper eligible model under Budget and checks required vision/JSON capabilities', async () => {
    const { router, settings, models } = harness(
      [provider('openai-compatible', 'expensive'), provider('openai-compatible', 'cheap')],
      () => sse(openaiText()),
    );
    settings.models.roles.executor = null;
    settings.models.preset = 'budget';
    models[0]!.price = { inputPerMTok: 10, outputPerMTok: 100 };
    models[1]!.price = { inputPerMTok: 0.1, outputPerMTok: 0.1 };
    expect((await router.generate(input)).providerId).toBe('cheap');
    models[1]!.supports.vision = false;
    expect((await router.generate({ ...input, role: 'vision' })).providerId).toBe('expensive');
    models.forEach((model) => {
      model.supports.json = false;
    });
    await expect(router.generate({ ...input, requireJson: true })).rejects.toMatchObject({
      code: 'MODEL_NOT_AVAILABLE',
    });
  });

  it('falls back on 429/5xx with SDK retries disabled and escalates the third attempt to Planner', async () => {
    const providers = ['primary', 'alternate', 'unused', 'planner'].map((id) =>
      provider('openai-compatible', id),
    );
    const usage: GenerationUsageRecord[] = [];
    const { router, settings, requests } = harness(providers, (request) =>
      request.url.hostname.startsWith('planner')
        ? sse(openaiText())
        : json(
            { error: { message: 'private provider failure' } },
            request.url.hostname.startsWith('primary') ? 429 : 503,
          ),
    );
    settings.models.fallbackOrder = ['alternate', 'unused', 'planner'];
    settings.models.roles.planner = { providerId: 'planner', modelId: 'fixture-model' };
    const result = await router.generate({
      ...input,
      onUsage: (record) => {
        usage.push(record);
      },
    });
    expect(result.providerId).toBe('planner');
    expect(requests.map((entry) => entry.url.hostname)).toEqual([
      'primary.example.test',
      'alternate.example.test',
      'planner.example.test',
    ]);
    expect(usage.map((record) => record.status)).toEqual(['failed', 'failed', 'completed']);
    expect(usage[0]?.costUsd).toBe(0);
    expect(usage[1]?.costEstimated).toBe(true);
  });

  it('opens the failing provider circuit, suppresses calls during cooldown, and probes after cooldown', async () => {
    let now = 0;
    let failing = true;
    const { router, requests } = harness(
      [provider('openai-compatible', 'primary'), provider('ollama', 'fallback')],
      (request) =>
        request.url.hostname.startsWith('primary') && failing
          ? json({ error: { message: 'unavailable' } }, 503)
          : sse(openaiText()),
      { now: () => now, circuitFailureThreshold: 2, circuitCooldownMs: 1000, requestBurst: 100 },
    );
    await router.generate(input);
    await router.generate(input);
    const third = await router.generate(input);
    expect(third.providerId).toBe('fallback');
    expect(requests.filter((entry) => entry.url.hostname.startsWith('primary'))).toHaveLength(2);
    now = 1001;
    failing = false;
    expect((await router.generate(input)).providerId).toBe('primary');
    expect(requests.filter((entry) => entry.url.hostname.startsWith('primary'))).toHaveLength(3);
  });

  it('limits bursts per provider and refills capacity without a retry storm', async () => {
    let now = 0;
    const { router, requests } = harness([provider('ollama')], () => sse(openaiText()), {
      now: () => now,
      requestBurst: 1,
      requestsPerMinute: 60,
    });
    await router.generate(input);
    await expect(router.generate(input)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT' });
    now = 1000;
    await router.generate(input);
    expect(requests).toHaveLength(2);
  });

  it('uses supplied provider admission as the rate authority and still refuses exhausted capacity', async () => {
    const admission = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const { router, requests } = harness([provider('ollama')], () => sse(openaiText()), {
      now: () => 0,
      requestBurst: 1,
      admitProvider: admission,
    });
    await router.generate(input);
    await router.generate(input);
    await expect(router.generate(input)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT' });
    expect(admission).toHaveBeenCalledTimes(3);
    expect(requests).toHaveLength(2);
  });

  it('never falls back after already-emitted text and records partial usage without raw provider errors', async () => {
    const captured: string[] = [];
    const usage: GenerationUsageRecord[] = [];
    const { router, requests } = harness(
      [provider('openai-compatible', 'primary'), provider('ollama', 'fallback')],
      () =>
        sse([
          ...openaiText(['Partial text ']).slice(0, 1),
          {
            error: {
              message: 'canary-private-response',
              type: 'server_error',
              code: 'server_error',
            },
          },
        ]),
    );
    const error = await router
      .generate({
        ...input,
        onToken: (token) => {
          captured.push(token);
        },
        onUsage: (record) => {
          usage.push(record);
        },
      })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ code: 'MODEL_STREAM_FAILED' });
    expect(String(error)).not.toContain('canary-private-response');
    expect(requests).toHaveLength(1);
    expect(captured.join('')).toBe('Partial text ');
    expect(usage[0]).toMatchObject({ status: 'failed', costEstimated: true });
    expect(usage[0]?.usage.outputTokens).toBeGreaterThan(0);
  });

  it('discards unexposed buffered text on failure so fallback does not duplicate chunks', async () => {
    const chunks: string[] = [];
    const { router } = harness(
      [provider('openai-compatible', 'primary'), provider('ollama', 'fallback')],
      (request) =>
        request.url.hostname.startsWith('primary')
          ? sse([...openaiText(['Buffered']).slice(0, 1), { error: { message: 'unavailable' } }])
          : sse(openaiText(['Fresh response.'])),
    );
    expect(
      (
        await router.generate({
          ...input,
          onToken: (token) => {
            chunks.push(token);
          },
        })
      ).providerId,
    ).toBe('fallback');
    expect(chunks.join('')).toBe('Fresh response.');
  });

  it('fails closed if the cost ledger fails and never retries the completed generation', async () => {
    const { router, requests } = harness(
      [provider('openai-compatible', 'first'), provider('ollama', 'second')],
      () => sse(openaiText()),
    );
    await expect(
      router.generate({
        ...input,
        onUsage: () => {
          throw new Error('private db failure');
        },
      }),
    ).rejects.toMatchObject({ code: 'USAGE_RECORD_FAILED' });
    expect(requests).toHaveLength(1);
  });

  it('charges failed attempts against the remaining budget before choosing a fallback', async () => {
    const { router, models, requests } = harness(
      [provider('openai-compatible', 'first'), provider('openai-compatible', 'second')],
      () =>
        sse([
          {
            choices: [{ index: 0, delta: {}, finish_reason: null }],
            usage: { prompt_tokens: 500, completion_tokens: 500 },
          },
          { error: { message: 'failed' } },
        ]),
    );
    models.forEach((entry) => {
      entry.price = { inputPerMTok: 100, outputPerMTok: 100 };
    });
    // Each admitted 1-token response fits, but a reported overspend cannot fund a fallback.
    const attemptedUsage: GenerationUsageRecord[] = [];
    await expect(
      router.generate({
        ...input,
        maxOutputTokens: 1,
        remainingBudgetUsd: 0.015,
        onUsage: (record) => {
          attemptedUsage.push(record);
        },
      }),
    ).rejects.toMatchObject({ code: 'MODEL_BUDGET_EXCEEDED' });
    expect(requests).toHaveLength(1);
    expect(attemptedUsage).toHaveLength(1);
  });

  it('bounds native structured output to one schema repair and accounts both calls', async () => {
    const usage: GenerationUsageRecord[] = [];
    let count = 0;
    const { router, requests } = harness([provider('openai-compatible')], () =>
      sse(openaiText([++count === 1 ? '{"count":"wrong"}' : '{"count":3}'])),
    );
    const result = await router.generateObject(
      {
        ...input,
        onUsage: (record) => {
          usage.push(record);
        },
      },
      z.strictObject({ count: z.number().int().positive() }),
    );
    expect(result.object).toEqual({ count: 3 });
    expect(requests).toHaveLength(2);
    expect(usage).toHaveLength(2);
    const posted = z
      .object({ response_format: z.object({ type: z.literal('json_schema') }) })
      .parse(requests[0]?.body);
    expect(posted.response_format.type).toBe('json_schema');
    expect(JSON.stringify(requests[1]?.body)).toContain('Schema validation failed');
  });

  it.each(['not JSON', '{"count":"wrong"}'])(
    'accounts one invalid structured response without repair when limited: %s',
    async (text) => {
      const usage: GenerationUsageRecord[] = [];
      const { router, requests } = harness([provider('openai-compatible')], () =>
        sse(openaiText([text])),
      );
      await expect(
        router.generateObject(
          {
            ...input,
            onUsage: (record) => {
              usage.push(record);
            },
          },
          z.strictObject({ count: z.number().int().positive() }),
          { maxAttempts: 1 },
        ),
      ).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
      expect(requests).toHaveLength(1);
      expect(usage).toHaveLength(1);
    },
  );

  it('repairs malformed JSON once and stops repeated malformed responses', async () => {
    const { router, requests } = harness([provider('openai-compatible')], () =>
      sse(openaiText(['not JSON'])),
    );
    await expect(
      router.generateObject(input, z.object({ answer: z.string() })),
    ).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
    expect(requests).toHaveLength(2);
  });

  it('keeps cancellation, authentication and vault failures typed without retries or secret text', async () => {
    const fetching = vi.fn(() => json({ error: { message: 'raw-secret-error' } }, 401));
    const { router, requests, settings } = harness([provider('openai-compatible')], fetching);
    const aborted = new AbortController();
    aborted.abort();
    await expect(router.generate({ ...input, signal: aborted.signal })).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(requests).toHaveLength(0);
    await expect(router.generate(input)).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
    expect(requests).toHaveLength(1);
    settings.providers.items[0]!.enabled = false;
    expect(await router.health('openai-compatible')).toMatchObject({
      ok: false,
      code: 'PROVIDER_DISABLED',
    });
    expect(await router.health('missing')).toMatchObject({ ok: false, code: 'PROVIDER_NOT_FOUND' });
    const locked = harness([provider('openai')], () => sse(openaiText()), {
      resolveSecret: () => Promise.reject(new Error('secret in vault error')),
    });
    await expect(locked.router.generate(input)).rejects.toMatchObject({
      code: 'VAULT_UNAVAILABLE',
    });
    expect(locked.requests).toHaveLength(0);
  });

  it('validates request/catalog boundaries before contacting providers', async () => {
    const { router, models, requests } = harness([provider('ollama')], () => sse(openaiText()));
    await expect(
      router.generate({ ...input, remainingBudgetUsd: Number.NaN }),
    ).rejects.toMatchObject({ code: 'MODEL_INVALID_INPUT' });
    await expect(
      router.generate({
        ...input,
        tools: [
          { name: 'bad', description: 'Invalid schema', inputSchema: { type: () => 'object' } },
        ],
      }),
    ).rejects.toMatchObject({ code: 'MODEL_INVALID_INPUT' });
    models[0]!.price = { inputPerMTok: -1, outputPerMTok: 0 };
    await expect(router.generate(input)).rejects.toMatchObject({ code: 'MODEL_INVALID_INPUT' });
    expect(requests).toHaveLength(0);
  });
});
