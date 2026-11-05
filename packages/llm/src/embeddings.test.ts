import { describe, expect, it, vi } from 'vitest';
import { fixtureKey, harness, json, provider } from './test-fixtures.js';
import type { GenerationUsageRecord } from './contracts.js';

const input = {
  providerId: 'embed',
  modelId: 'fixture-model',
  texts: ['Orchid launch', 'A second passage'],
  privateOnly: false,
  remainingBudgetUsd: 1,
};
const response = {
  object: 'list',
  model: 'fixture-model',
  data: [
    { object: 'embedding', index: 0, embedding: [1, 0, 0] },
    { object: 'embedding', index: 1, embedding: [0, 1, 0] },
  ],
  usage: { prompt_tokens: 8, total_tokens: 8 },
};
describe('embedding adapters and priced execution', () => {
  it.each(['openai', 'openai-compatible', 'ollama'] as const)(
    'uses the %s adapter and records reported usage',
    async (kind) => {
      const { router, requests } = harness([provider(kind, 'embed')], () => json(response));
      const onUsage = vi.fn<(record: GenerationUsageRecord) => void>();
      expect(await router.embed({ ...input, onUsage })).toMatchObject({
        vectors: [
          [1, 0, 0],
          [0, 1, 0],
        ],
        dimensions: 3,
        providerId: 'embed',
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url.pathname).toContain('embeddings');
      expect(JSON.stringify(requests[0]?.body)).not.toContain(fixtureKey);
      expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
        usage: { inputTokens: 8, source: 'provider' },
        status: 'completed',
      });
    },
  );
  it('uses Google embedding responses through its adapter', async () => {
    const { router } = harness([provider('google', 'embed')], () =>
      json({ embeddings: [{ values: [1, 0] }, { values: [0, 1] }] }),
    );
    expect((await router.embed(input)).vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });
  it('rejects cloud privacy, missing prices, unaffordable calls and secrets before transport', async () => {
    const { router, requests, models } = harness([provider('openai-compatible', 'embed')], () =>
      json(response),
    );
    await expect(router.embed({ ...input, privateOnly: true })).rejects.toMatchObject({
      code: 'MODEL_NOT_AVAILABLE',
    });
    await expect(router.embed({ ...input, remainingBudgetUsd: 0 })).rejects.toMatchObject({
      code: 'MODEL_BUDGET_EXCEEDED',
    });
    await expect(router.embed({ ...input, texts: [fixtureKey] })).rejects.toMatchObject({
      code: 'MODEL_INVALID_INPUT',
    });
    models[0]!.price = null;
    await expect(router.embed(input)).rejects.toMatchObject({ code: 'MODEL_PRICE_REQUIRED' });
    expect(requests).toHaveLength(0);
  });
  it('does not retry, switch vector spaces or expose provider errors and records failed attempts', async () => {
    const onUsage = vi.fn();
    const { router, requests } = harness(
      [provider('openai-compatible', 'embed'), provider('ollama', 'other')],
      () => json({ error: { message: fixtureKey } }, 500),
    );
    await expect(router.embed({ ...input, onUsage })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE',
    });
    expect(requests).toHaveLength(1);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', costEstimated: true }),
    );
    expect(JSON.stringify(onUsage.mock.calls)).not.toContain(fixtureKey);
  });
  it.each([
    {
      vectors: [
        [0, 0],
        [0, 1],
      ],
    },
    { vectors: [[1], [1, 2]] },
    { vectors: [[1, 0]] },
  ])('rejects malformed vector sets %#', async ({ vectors }) => {
    const { router } = harness([provider('openai-compatible', 'embed')], () =>
      json({
        ...response,
        data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
      }),
    );
    await expect(router.embed(input)).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });
});
