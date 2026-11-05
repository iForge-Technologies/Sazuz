import { describe, expect, it, vi } from 'vitest';
import { evalCaseSchema } from '@sazuz/core/evals';
import { workKey } from '@sazuz/db';
import { newCheckpoint } from '@sazuz/runtime';
import type { GenerateRequest, GenerateResult } from '@sazuz/llm/contracts';
import { builtinSuites, suiteHash } from './loader.js';
import { evaluateCase, type EvaluateCaseOptions } from './runner.js';
import { memoryPersistence, newJournal } from './journal.js';
import { createFixturePlan, runFixturePlan } from './offline.js';
import { comparisonRows, renderEvalHtml } from './report.js';

const source = () => builtinSuites()[0]!;
function options(input = source().cases[0]!): EvaluateCaseOptions {
  return {
    id: workKey('evc'),
    suite: 'inbox-triage',
    suiteHash: suiteHash(source()),
    input,
    preset: 'balanced',
    mode: 'fixture',
    projectId: 'eval-test',
    privateOnly: true,
    persistence: memoryPersistence(),
    maxCostUsd: 1,
    maxWallTimeSeconds: 60,
    remainingBudget: () => Promise.resolve(1),
  };
}
async function response(
  request: GenerateRequest,
  text: string,
  cost = 0.01,
): Promise<GenerateResult> {
  const result: GenerateResult = {
    providerId: 'fixture',
    modelId: 'fixture-model',
    text,
    toolCalls: [],
    costUsd: cost,
    costEstimated: false,
    latencyMs: 3,
    usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, source: 'provider' },
    finishReason: 'stop',
  };
  await request.onUsage?.({
    providerId: result.providerId,
    modelId: result.modelId,
    usage: result.usage,
    costUsd: result.costUsd,
    costEstimated: result.costEstimated,
    latencyMs: result.latencyMs,
    status: 'completed',
  });
  return result;
}
describe('isolated production-loop evaluations', () => {
  it('compares two presets across three suites and retains non-vacuous mock dispatches', async () => {
    const report = await runFixturePlan(createFixturePlan(builtinSuites(), ['balanced', 'budget']));
    expect(report).toMatchObject({
      totalCases: 12,
      completedCases: 12,
      passedCases: 12,
      costUsd: 0,
      mode: 'fixture',
    });
    expect(comparisonRows(report)).toHaveLength(6);
    expect(report.results.reduce((sum, item) => sum + item.dispatches.length, 0)).toBeGreaterThan(
      12,
    );
    expect(
      report.results.every(
        (item) =>
          item.liveDispatches === 0 && item.unauthorizedEffects === 0 && item.modelCalls === 0,
      ),
    ).toBe(true);
    expect(report.results.some((item) => item.outcome === 'waiting_approval')).toBe(true);
    const html = renderEvalHtml(report);
    expect(html).toContain('Deterministic fixture mode');
    expect(html).toContain('inbox-triage');
    expect(html).not.toContain('<script');
  });
  it('recovers a lost mock completion checkpoint through verification, with one receipt per action', async () => {
    const persisted = memoryPersistence();
    const first = options();
    await expect(
      evaluateCase({
        ...first,
        persistence: {
          load: persisted.load,
          save: (checkpoint, journal) => {
            if (journal.tools.some((item) => item.status === 'done'))
              return Promise.reject(new Error('Simulated process loss before checkpoint commit.'));
            return persisted.save(checkpoint, journal);
          },
        },
      }),
    ).rejects.toThrow();
    const before = await persisted.load();
    expect(before?.journal.tools[0]?.status).toBe('intent');
    const result = await evaluateCase({ ...first, persistence: persisted });
    expect(result.passed).toBe(true);
    expect(result.dispatches).toHaveLength(2);
    expect((await persisted.load())?.journal.models).toHaveLength(3);
    expect(new Set(result.dispatches.map((item) => item.key)).size).toBe(2);
    expect(result.liveDispatches).toBe(0);
  });
  it('does not repeat an interrupted configured inference', async () => {
    const journal = newJournal();
    journal.models.push({ key: 'model:0', kind: 'agent', status: 'intent', response: null });
    const persistence = memoryPersistence({
      checkpoint: newCheckpoint([{ role: 'user', content: 'Triage the fixture.' }]),
      journal,
    });
    const generate = vi.fn(() =>
      Promise.reject(new Error('No repeated billed request is permitted.')),
    );
    const first = options();
    const result = await evaluateCase({ ...first, mode: 'configured', generate, persistence });
    expect(result).toMatchObject({ outcome: 'paused', passed: false, flags: ['interrupted'] });
    await evaluateCase({ ...first, mode: 'configured', generate, persistence });
    expect(generate).not.toHaveBeenCalled();
  });
  it('uses a separately charged tool-free judge and reuses saved answers after finalization loss', async () => {
    const input = evalCaseSchema.parse({
      id: 'judge',
      task: 'Return a concise answer.',
      tools: ['time.now'],
      fixtures: [],
      fixtureTurns: [{ text: 'answer' }],
      expect: [{ text_contains: 'answer' }, { llm_judge: 'The response says answer.' }],
    });
    const requests: GenerateRequest[] = [];
    const generate = vi.fn((request: GenerateRequest) => {
      requests.push(request);
      return response(
        request,
        request.role === 'fast'
          ? JSON.stringify({ passed: true, reason: 'The required word is present.' })
          : 'answer',
      );
    });
    const setup = { ...options(input), mode: 'configured' as const, judge: true, generate };
    const result = await evaluateCase(setup);
    expect(result).toMatchObject({
      passed: true,
      costUsd: 0.02,
      judgeCostUsd: 0.01,
      modelCalls: 2,
    });
    expect(requests[1]).toMatchObject({
      tools: [],
      role: 'fast',
      privateOnly: true,
      requireJson: true,
    });
    expect(requests[1]!.messages[1]!.content).toContain('<untrusted>');
    await evaluateCase(setup);
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it('retains charges for an invalid judge and never treats a skipped judge as verified', async () => {
    const input = evalCaseSchema.parse({
      id: 'judge',
      task: 'Return answer.',
      tools: ['time.now'],
      fixtures: [],
      fixtureTurns: [{ text: 'answer' }],
      expect: [{ llm_judge: 'The response says answer.' }],
    });
    const skipped = await evaluateCase(options(input));
    expect(skipped.passed).toBe(false);
    expect(skipped.grades[0]?.passed).toBeNull();
    const invalid = await evaluateCase({
      ...options(input),
      mode: 'configured',
      judge: true,
      generate: (request) => response(request, 'answer'),
    });
    expect(invalid).toMatchObject({ passed: false, costUsd: 0.02, judgeCostUsd: 0.01 });
    expect(invalid.grades[0]?.passed).toBe(false);
  });
  it('enforces the step and loop budgets in fixture mode', async () => {
    const input = evalCaseSchema.parse({
      id: 'repeat',
      task: 'Read the fixture.',
      tools: ['files.read'],
      fixtures: [{ name: 'files.read', args: { path: 'note.txt' }, output: { content: 'note' } }],
      fixtureTurns: Array.from({ length: 4 }, (_, index) => ({
        text: 'Read again.',
        toolCalls: [{ id: `call-${index}`, name: 'files.read', args: { path: 'note.txt' } }],
      })),
      expect: [{ tool_called: { name: 'files.read' } }],
    });
    expect((await evaluateCase({ ...options(input), maxSteps: 1 })).outcome).toBe(
      'budget_exceeded',
    );
    const loop = await evaluateCase(options(input));
    expect(loop.outcome).toBe('failed');
    expect(loop.dispatches).toHaveLength(2);
  });
  it('does not reset the saved offline batch deadline on resume', async () => {
    const plan = createFixturePlan([source()], ['balanced']);
    plan.createdAt = new Date(Date.now() - 601_000).toISOString();
    await expect(runFixturePlan(plan)).rejects.toMatchObject({ code: 'EVAL_LIMIT' });
  });
  it('escapes model output, grader evidence and report JSON without active markup', async () => {
    const report = await runFixturePlan(createFixturePlan([source()], ['balanced']));
    report.results[0]!.text = '</pre><script>alert("fixture")</script><img src=x onerror=alert(1)>';
    report.results[0]!.grades[0]!.evidence = '<svg onload=alert(1)>';
    const html = renderEvalHtml(report);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain("default-src 'none'");
  });
});
