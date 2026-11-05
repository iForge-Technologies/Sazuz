import { describe, expect, it } from 'vitest';
import { llmMessageSchema, type GenerationUsageRecord } from './contracts.js';
import { anthropicText, googleText, harness, openaiText, provider, sse } from './test-fixtures.js';

const image = {
  mimeType: 'image/jpeg' as const,
  data: Buffer.from([255, 216, 255, 224, 1, 2, 3, 255, 217]).toString('base64'),
};
const request = {
  role: 'vision' as const,
  messages: [
    {
      role: 'user' as const,
      content: '<untrusted>Describe this page.</untrusted>',
      images: [image],
    },
  ],
  tools: [
    {
      name: 'browser.read',
      description: 'Read the page.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  remainingBudgetUsd: 1,
};

describe('transient browser vision through provider adapters', () => {
  it.each(['openai', 'openai-compatible', 'anthropic', 'google', 'ollama'] as const)(
    'carries JPEGs and tools through %s and records only usage metadata',
    async (kind) => {
      const result = harness([provider(kind)], () =>
        sse(
          kind === 'anthropic' ? anthropicText() : kind === 'google' ? googleText() : openaiText(),
          !['anthropic', 'google'].includes(kind),
        ),
      );
      const usage: GenerationUsageRecord[] = [];
      const response = await result.router.generate({
        ...request,
        onUsage: (record) => {
          usage.push(record);
        },
      });
      expect(response.text).toBe('Hello world.');
      const wire = JSON.stringify(result.requests[0]?.body);
      expect(wire).toContain(image.data);
      expect(wire).toContain('image/jpeg');
      expect(wire).toContain('browser_read');
      expect(usage).toHaveLength(1);
      expect(usage[0]?.usage.source).toBe('provider');
      expect(JSON.stringify(usage)).not.toContain(image.data);
      expect(JSON.stringify(response)).not.toContain(image.data);
    },
  );
  it('requires both tool and vision support even when images are attached to an executor request', async () => {
    for (const unsupported of ['vision', 'tools'] as const) {
      const result = harness([provider('openai')], () => sse(openaiText()));
      result.models[0]!.supports[unsupported] = false;
      await expect(result.router.generate({ ...request, role: 'executor' })).rejects.toMatchObject({
        code: 'MODEL_NOT_AVAILABLE',
      });
      expect(result.requests).toEqual([]);
    }
  });
  it('preserves private routing and refuses an image that exceeds the remaining budget before a provider call', async () => {
    const result = harness([provider('openai')], () => sse(openaiText()));
    await expect(result.router.generate({ ...request, privateOnly: true })).rejects.toMatchObject({
      code: 'MODEL_NOT_AVAILABLE',
    });
    await expect(
      result.router.generate({
        ...request,
        maxOutputTokens: 16,
        remainingBudgetUsd: 0.003,
        messages: [
          {
            ...request.messages[0]!,
            images: [{ ...image, data: Buffer.alloc(4096, 1).toString('base64') }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'MODEL_BUDGET_EXCEEDED' });
    expect(result.requests).toEqual([]);
  });
  it('selects the configured eligible Vision model and bounds accepted image messages', async () => {
    const result = harness([provider('openai'), provider('ollama')], () => sse(openaiText()));
    result.settings.models.roles.vision = { providerId: 'ollama', modelId: result.models[1]!.id };
    expect((await result.router.generate(request)).providerId).toBe('ollama');
    expect(
      llmMessageSchema.safeParse({ role: 'system', content: '', images: [image] }).success,
    ).toBe(false);
    expect(
      llmMessageSchema.safeParse({ ...request.messages[0], images: [image, image] }).success,
    ).toBe(false);
    expect(
      llmMessageSchema.safeParse({
        ...request.messages[0],
        images: [{ ...image, data: 'a'.repeat(2000001) }],
      }).success,
    ).toBe(false);
  });
});
