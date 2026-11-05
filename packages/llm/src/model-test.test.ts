import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { GenerationUsageRecord } from './contracts.js';
import { harness, json, model, openaiText, provider, sse } from './test-fixtures.js';

describe('selected-model inference test', () => {
  it('executes the exact selected model rather than the role assignment or discovery endpoint', async () => {
    const sources = [provider('openai-compatible', 'primary'), provider('ollama', 'selected')];
    const { router, models, requests } = harness(sources, () => sse(openaiText(['OK.'])));
    models.push(model(sources[1]!, 'selected-model'));
    const usage: GenerationUsageRecord[] = [];
    const result = await router.testModel('selected', 'selected-model', {
      remainingBudgetUsd: 0,
      onUsage: (record) => {
        usage.push(record);
      },
    });
    expect(result).toMatchObject({
      providerId: 'selected',
      modelId: 'selected-model',
      text: 'OK.',
      costUsd: 0,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.hostname).toBe('selected.example.test');
    expect(requests[0]?.url.pathname).toBe('/v1/chat/completions');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      providerId: 'selected',
      modelId: 'selected-model',
      status: 'completed',
      usage: { source: 'provider' },
    });
    const body = z
      .object({
        model: z.string(),
        messages: z.array(z.object({ role: z.string(), content: z.string() })),
        max_tokens: z.number(),
        tools: z.array(z.unknown()).optional(),
      })
      .parse(requests[0]?.body);
    expect(body.model).toBe('selected-model');
    expect(body.messages).toEqual([{ role: 'user', content: 'Reply with OK.' }]);
    expect(body.max_tokens).toBe(16);
    expect(body.tools ?? []).toHaveLength(0);
  });

  it('does not hide a failed selected model by falling back and records the failed bill', async () => {
    const usage: GenerationUsageRecord[] = [];
    const { router, requests } = harness(
      [provider('openai-compatible', 'failed'), provider('ollama', 'fallback')],
      (request) =>
        request.url.hostname.startsWith('failed')
          ? json({ error: { message: 'private-provider-error' } }, 503)
          : sse(openaiText(['OK.'])),
    );
    await expect(
      router.testModel('failed', 'fixture-model', {
        remainingBudgetUsd: 1,
        onUsage: (record) => {
          usage.push(record);
        },
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(requests).toHaveLength(1);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ providerId: 'failed', status: 'failed', costEstimated: true });
  });

  it('requires an enabled discovered model, known price and spend budget before inference', async () => {
    const { router, models, settings, requests } = harness([provider('openai-compatible')], () =>
      sse(openaiText(['OK.'])),
    );
    await expect(
      router.testModel('openai-compatible', 'not-discovered', { remainingBudgetUsd: 1 }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_AVAILABLE' });
    models[0]!.price = null;
    await expect(
      router.testModel('openai-compatible', 'fixture-model', { remainingBudgetUsd: 1 }),
    ).rejects.toMatchObject({ code: 'MODEL_PRICE_REQUIRED' });
    models[0]!.price = { inputPerMTok: 1, outputPerMTok: 1 };
    await expect(
      router.testModel('openai-compatible', 'fixture-model', { remainingBudgetUsd: 0 }),
    ).rejects.toMatchObject({ code: 'MODEL_BUDGET_EXCEEDED' });
    settings.providers.items[0]!.enabled = false;
    await expect(
      router.testModel('openai-compatible', 'fixture-model', { remainingBudgetUsd: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
    expect(requests).toHaveLength(0);
  });

  it('honors the private preset and shares the inference rate limit', async () => {
    const { router, settings, requests } = harness(
      [provider('openai-compatible', 'cloud'), provider('ollama', 'local')],
      () => sse(openaiText(['OK.'])),
      { requestBurst: 1 },
    );
    settings.models.preset = 'private';
    await expect(
      router.testModel('cloud', 'fixture-model', { remainingBudgetUsd: 1 }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_AVAILABLE' });
    await router.testModel('local', 'fixture-model', { remainingBudgetUsd: 0 });
    await expect(
      router.testModel('local', 'fixture-model', { remainingBudgetUsd: 0 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT' });
    expect(requests).toHaveLength(1);
  });

  it('stops if test usage cannot be persisted', async () => {
    const { router, requests } = harness([provider('ollama')], () => sse(openaiText(['OK.'])));
    await expect(
      router.testModel('ollama', 'fixture-model', {
        remainingBudgetUsd: 0,
        onUsage: () => {
          throw new Error('ledger unavailable');
        },
      }),
    ).rejects.toMatchObject({ code: 'USAGE_RECORD_FAILED' });
    expect(requests).toHaveLength(1);
  });
});

describe('Planner escalation', () => {
  it('tries the Planner once after two failed attempts even on an already-attempted provider', async () => {
    const source = provider('openai-compatible', 'shared');
    const { router, models, settings, requests } = harness(
      [source, provider('openai-compatible', 'fallback')],
      (request) => {
        const body = z.object({ model: z.string() }).parse(request.body);
        return body.model === 'strong-planner'
          ? sse(openaiText(['Recovered.']))
          : json({ error: { message: 'temporarily unavailable' } }, 503);
      },
    );
    models.push(model(source, 'strong-planner'));
    settings.models.roles.planner = { providerId: source.id, modelId: 'strong-planner' };
    const result = await router.generate({
      messages: [{ role: 'user', content: 'Answer briefly.' }],
      remainingBudgetUsd: 1,
    });
    expect(result).toMatchObject({ providerId: 'shared', modelId: 'strong-planner' });
    expect(
      requests.map((request) => z.object({ model: z.string() }).parse(request.body).model),
    ).toEqual(['fixture-model', 'fixture-model', 'strong-planner']);
    expect(requests).toHaveLength(3);
  });

  it('never escalates a private request to a cloud Planner', async () => {
    const sources = [
      provider('ollama', 'first'),
      provider('ollama', 'second'),
      provider('openai-compatible', 'planner'),
    ];
    const { router, settings, requests } = harness(sources, () =>
      json({ error: { message: 'temporarily unavailable' } }, 503),
    );
    settings.models.roles.planner = { providerId: 'planner', modelId: 'fixture-model' };
    await expect(
      router.generate({
        messages: [{ role: 'user', content: 'Private information.' }],
        remainingBudgetUsd: 1,
        privateOnly: true,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => !request.url.hostname.startsWith('planner'))).toBe(true);
  });
});
