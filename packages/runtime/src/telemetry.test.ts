import { expect, it } from 'vitest';
import { ledgerSpans } from './telemetry.js';

it('constructs content-free OTLP spans even when metadata contains a secret or URL', () => {
  const row = {
    id: 'call-id',
    runId: 'run-id',
    projectId: null,
    agentId: 'writer',
    providerId: 'https://hidden.example/token',
    modelId: 'sensitive-canary',
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 5,
    cachedInputTokens: 10,
    latencyMs: 12.5,
    estimated: false,
    status: 'completed',
    createdAt: new Date('2026-11-05T00:00:00Z'),
    prompt: 'do not export this',
    error: 'private data',
  };
  const payload = ledgerSpans([row, { ...row, id: 'failed', runId: null, status: 'failed' }]);
  const json = JSON.stringify(payload);
  for (const value of [
    'sensitive-canary',
    'hidden.example',
    'do not export this',
    'private data',
    'call-id',
    'run-id',
  ])
    expect(json).not.toContain(value);
  const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
  expect(spans[0]!.traceId).toHaveLength(32);
  expect(spans[0]!.spanId).toHaveLength(16);
  expect(spans.map((span) => span.status.code)).toEqual([1, 2]);
  expect(BigInt(spans[0]!.endTimeUnixNano) - BigInt(spans[0]!.startTimeUnixNano)).toBe(13_000_000n);
  expect(() => ledgerSpans([{ ...row, costUsd: Infinity }])).toThrow();
});
