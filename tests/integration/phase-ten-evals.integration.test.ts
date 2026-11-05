import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  costLedger,
  createProject,
  evalResults,
  evalRuns,
  getControl,
  projects,
  readSettings,
  saveSetting,
  setControl,
  users,
} from '@sazuz/db';
import { evalReportSchema, evalRunSchema } from '@sazuz/core/evals';
import type { SettingsValues } from '@sazuz/config/settings';
import type { GenerateRequest, GenerateResult } from '../../packages/llm/src/contracts.js';
import { newCheckpoint } from '../../packages/runtime/src/index.js';
import {
  builtinSuites,
  databasePersistence,
  evaluationReport,
  executeEvaluation,
  newJournal,
  nextEvaluation,
  startEvaluation,
} from '../../packages/evals/src/index.js';
import { registerEvaluations } from '../../apps/server/src/phase-ten-evals.js';
import { phaseFourFixture } from './phase-four-fixture.js';

describe('Phase 10 owned and durable evaluations', () => {
  let f: Awaited<ReturnType<typeof phaseFourFixture>>;
  const allCases = () => builtinSuites(true).flatMap((suite) => suite.cases);
  const request = (value: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    projectId: f.projectId,
    suites: ['all'],
    presets: ['balanced', 'budget'],
    mode: 'fixture',
    judge: false,
    ...value,
  });
  async function budget(value: Partial<SettingsValues['budgets']>) {
    const before = (await readSettings(f.db)).budgets;
    const saved = await saveSetting(f.db, {
      namespace: 'budgets',
      actorId: f.userId,
      expectedVersion: before.version,
      value: { ...before.value, ...value },
    });
    await vi.waitFor(() => expect(f.runtime.settings.budgets.version).toBe(saved.version));
  }
  async function generated(
    input: GenerateRequest,
    override?: { text?: string; failed?: boolean; cost?: number },
  ): Promise<GenerateResult> {
    const task = allCases().find((item) =>
      input.messages.some((message) => message.role === 'user' && message.content === item.task),
    );
    const turn =
      task?.fixtureTurns[input.messages.filter((message) => message.role === 'assistant').length];
    const response: GenerateResult = {
      providerId: 'fixture',
      modelId: `${input.preset ?? 'balanced'}-model`,
      text:
        override?.text ??
        (input.role === 'fast'
          ? JSON.stringify({
              passed: true,
              reason: 'The recorded task and review boundary are satisfied.',
            })
          : (turn?.text ?? 'Invalid fixture turn.')),
      toolCalls: input.role === 'fast' || override?.text ? [] : (turn?.toolCalls ?? []),
      costUsd: override?.cost ?? 0.001,
      costEstimated: false,
      latencyMs: 2,
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, source: 'provider' },
      finishReason: 'stop',
    };
    await input.onUsage?.({
      providerId: response.providerId,
      modelId: response.modelId,
      usage: response.usage,
      costUsd: response.costUsd,
      costEstimated: false,
      latencyMs: 2,
      status: override?.failed ? 'failed' : 'completed',
    });
    if (override?.failed) throw new Error('Deliberate provider failure after usage.');
    return response;
  }
  const executor = (
    generate: (input: GenerateRequest) => Promise<GenerateResult> = (input) => generated(input),
  ) => ({ database: f.db, getSettings: () => f.runtime.settings, generate });
  beforeAll(async () => {
    f = await phaseFourFixture((app, runtime) =>
      registerEvaluations(app, runtime, { background: false }),
    );
  });
  beforeEach(async () => {
    await f.db.orm.delete(evalRuns);
    await f.db.orm.delete(costLedger);
    await f.db.orm
      .update(projects)
      .set({ budgetUsd: 5, privacy: 'standard' })
      .where(eq(projects.id, f.projectId));
    await budget({
      perRunUsd: 0.5,
      maxSteps: 40,
      maxWallTimeSeconds: 600,
      dailyUsd: 5,
      monthlyUsd: 50,
    });
  });
  afterAll(async () => {
    await f?.close();
  });
  it('enforces ownership, CSRF, schema and local-operator authority with idempotent request receipts', async () => {
    expect((await f.request('GET', '/api/evals/suites', undefined, false)).statusCode).toBe(401);
    expect((await f.request('GET', '/api/evals/suites?unexpected=1')).statusCode).toBe(400);
    expect(
      (await f.request('POST', '/api/evals', request(), true, 'https://elsewhere.example'))
        .statusCode,
    ).toBe(403);
    expect((await f.request('POST', '/api/evals', request({ judge: true }))).statusCode).toBe(400);
    expect(
      (await f.request('POST', '/api/evals', request({ suites: ['missing'] }))).statusCode,
    ).toBe(400);
    const body = request();
    const responses = await Promise.all([
      f.request('POST', '/api/evals', body),
      f.request('POST', '/api/evals', body),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    const created = evalRunSchema.parse(responses[0].json());
    expect(evalRunSchema.parse(responses[1].json()).id).toBe(created.id);
    expect(await f.db.orm.select().from(evalRuns)).toHaveLength(1);
    expect(
      (await f.request('POST', '/api/evals', { ...body, presets: ['budget'] })).statusCode,
    ).toBe(409);
    const outsider = 'phase-ten-eval-outsider';
    await f.db.orm
      .insert(users)
      .values({ id: outsider, name: 'Other owner', email: 'eval-outsider@example.test' });
    const foreign = await createProject(f.db, outsider, { name: 'Other project' });
    expect(
      (await f.request('POST', '/api/evals', request({ projectId: foreign.id }))).statusCode,
    ).toBe(404);
    const otherRun = await startEvaluation(
      f.db,
      outsider,
      request({ projectId: foreign.id }),
      f.runtime.settings,
    );
    expect((await f.request('GET', `/api/evals/${otherRun.id}`)).statusCode).toBe(404);
    expect((await f.request('GET', `/api/evals/${otherRun.id}/report`)).statusCode).toBe(404);
    const listed = (await f.request('GET', '/api/evals')).json<unknown[]>();
    expect(listed).toHaveLength(1);
    expect((await f.request('GET', '/api/operator/evals')).statusCode).toBe(403);
    const headers = { authorization: `Bearer ${f.runtime.plumbing.operatorKey}` };
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: '/api/operator/evals',
          headers,
          remoteAddress: '192.0.2.50',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await f.app.inject({ method: 'GET', url: '/api/operator/evals', headers })).statusCode,
    ).toBe(200);
    expect(await nextEvaluation(f.db)).toBe(created.id);
  });
  it('persists a two-preset three-suite comparison and returns escaped standalone HTML without live inference', async () => {
    const run = await startEvaluation(f.db, f.userId, request(), f.runtime.settings);
    const generate = vi.fn(() =>
      Promise.reject(new Error('Fixture evaluations must not call a model.')),
    );
    const result = await executeEvaluation(executor(generate), run.id);
    expect(result).toMatchObject({
      status: 'completed',
      totalCases: 12,
      completedCases: 12,
      passedCases: 12,
      costUsd: 0,
    });
    expect(
      result!.results.every((item) => item.unauthorizedEffects === 0 && item.liveDispatches === 0),
    ).toBe(true);
    const stored = await f.db.orm
      .select()
      .from(evalResults)
      .where(eq(evalResults.evalRunId, run.id));
    expect(stored.every((item) => item.status === 'done' && item.checkpoint && item.journal)).toBe(
      true,
    );
    await executeEvaluation(executor(generate), run.id);
    expect(await evaluationReport(f.db, f.userId, run.id)).toEqual(result);
    expect(generate).not.toHaveBeenCalled();
    expect(await f.db.orm.select().from(costLedger)).toHaveLength(0);
    expect(evalReportSchema.parse((await f.request('GET', `/api/evals/${run.id}`)).json())).toEqual(
      result,
    );
    const html = await f.request('GET', `/api/evals/${run.id}/report`);
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.headers['content-security-policy']).toContain("default-src 'none'");
    expect(html.body).toContain('report-data');
    expect(html.body).toContain('Deterministic fixture mode');
    expect(html.body).not.toContain('<script');
    expect(await nextEvaluation(f.db)).toBeNull();
  });
  it('accounts agent and tool-free judge calls once and tightens privacy after a request was created', async () => {
    const run = await startEvaluation(
      f.db,
      f.userId,
      request({ mode: 'configured', judge: true }),
      f.runtime.settings,
    );
    await f.db.orm.update(projects).set({ privacy: 'private' }).where(eq(projects.id, f.projectId));
    const requests: GenerateRequest[] = [];
    const generate = vi.fn((input: GenerateRequest) => {
      requests.push(input);
      return generated(input);
    });
    const result = await executeEvaluation(executor(generate), run.id);
    expect(result).toMatchObject({ status: 'completed', totalCases: 12, passedCases: 12 });
    expect(result!.costUsd).toBeCloseTo(0.04);
    expect(result!.judgeCostUsd).toBeCloseTo(0.012);
    expect(requests.every((item) => item.privateOnly)).toBe(true);
    const judges = requests.filter((item) => item.role === 'fast');
    expect(judges).toHaveLength(12);
    expect(judges.every((item) => item.tools?.length === 0 && item.requireJson)).toBe(true);
    expect(requests.some((item) => item.preset === 'budget')).toBe(true);
    const ledger = await f.db.orm.select().from(costLedger);
    expect(ledger).toHaveLength(requests.length);
    expect(ledger.filter((item) => item.agentId === 'eval-judge')).toHaveLength(12);
    await executeEvaluation(executor(generate), run.id);
    expect(generate).toHaveBeenCalledTimes(40);
    expect(await f.db.orm.select().from(costLedger)).toHaveLength(40);
  });
  it('retains charged provider failures and refuses to repeat an uncertain call', async () => {
    const run = await startEvaluation(
      f.db,
      f.userId,
      request({ mode: 'configured' }),
      f.runtime.settings,
    );
    const generate = vi.fn((input: GenerateRequest) =>
      generated(input, { failed: true, cost: 0.01 }),
    );
    const result = await executeEvaluation(executor(generate), run.id);
    expect(result).toMatchObject({ status: 'uncertain', passedCases: 0, costUsd: 0.01 });
    expect((await f.db.orm.select().from(costLedger))[0]).toMatchObject({
      status: 'failed',
      costUsd: 0.01,
    });
    await executeEvaluation(executor(generate), run.id);
    expect(generate).toHaveBeenCalledOnce();
  });
  it('recovers persisted inference intents without model calls and retains a stable failure report', async () => {
    const run = await startEvaluation(
      f.db,
      f.userId,
      request({ mode: 'configured' }),
      f.runtime.settings,
    );
    const [row] = await f.db.orm.select().from(evalRuns).where(eq(evalRuns.id, run.id));
    const [item] = await f.db.orm
      .select()
      .from(evalResults)
      .where(eq(evalResults.evalRunId, run.id))
      .orderBy(asc(evalResults.ordinal));
    const journal = newJournal();
    journal.models.push({ key: 'model:0', kind: 'agent', status: 'intent', response: null });
    await databasePersistence(f.db, row!, item!).save(
      newCheckpoint([{ role: 'user', content: allCases()[0]!.task }]),
      journal,
    );
    const generate = vi.fn(() =>
      Promise.reject(new Error('An interrupted request must not repeat.')),
    );
    const result = await executeEvaluation(executor(generate), run.id);
    expect(result).toMatchObject({ status: 'uncertain', completedCases: 1, passedCases: 0 });
    expect(result?.results[0]?.flags).toContain('interrupted');
    await executeEvaluation(executor(generate), run.id);
    expect(generate).not.toHaveBeenCalled();
    expect(await evaluationReport(f.db, f.userId, run.id)).toEqual(result);
  });
  it('keeps paid invalid judge output as a failed grade and redacts known secrets from every saved surface', async () => {
    const canary = 'phase-ten-eval-secret-canary-781964';
    await f.runtime.vault.create(
      { name: 'Eval redaction canary', value: canary, createdBy: f.userId },
      'user',
    );
    const run = await startEvaluation(
      f.db,
      f.userId,
      request({ mode: 'configured', judge: true, suites: ['research'], presets: ['budget'] }),
      f.runtime.settings,
    );
    const result = await executeEvaluation(
      executor((input) => generated(input, input.role === 'fast' ? { text: canary } : undefined)),
      run.id,
    );
    expect(result).toMatchObject({ status: 'completed', passedCases: 0, judgeCostUsd: 0.002 });
    expect(
      result?.results.every((item) =>
        item.grades.some((grade) => grade.kind === 'judge' && grade.passed === false),
      ),
    ).toBe(true);
    const rows = await f.db.orm.select().from(evalResults);
    expect(JSON.stringify(rows)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain(canary);
    expect((await f.request('GET', `/api/evals/${run.id}/report`)).body).not.toContain(canary);
    expect(await f.db.orm.select().from(costLedger)).toHaveLength(6);
  });
  it('rechecks the shared workspace and project caps before inference and never exceeds the case step limit', async () => {
    await f.db.orm.update(projects).set({ budgetUsd: 0 }).where(eq(projects.id, f.projectId));
    const run = await startEvaluation(
      f.db,
      f.userId,
      request({ mode: 'configured', suites: ['research'], presets: ['balanced'] }),
      f.runtime.settings,
    );
    const generate = vi.fn((input: GenerateRequest) => {
      expect(input.remainingBudgetUsd).toBe(0);
      return generated(input, { cost: 0 });
    });
    await executeEvaluation(executor(generate), run.id);
    expect(generate).toHaveBeenCalledTimes(4);
    await f.db.orm.update(projects).set({ budgetUsd: 5 }).where(eq(projects.id, f.projectId));
    await budget({ maxSteps: 1 });
    const bounded = await startEvaluation(
      f.db,
      f.userId,
      request({ mode: 'configured', suites: ['research'], presets: ['balanced'] }),
      f.runtime.settings,
    );
    const stopped = await executeEvaluation(executor(), bounded.id);
    expect(stopped).toMatchObject({ status: 'failed', completedCases: 1 });
    expect(stopped!.results[0]).toMatchObject({ outcome: 'budget_exceeded', modelCalls: 1 });
    const exhausted = await startEvaluation(
      f.db,
      f.userId,
      request({ mode: 'configured' }),
      f.runtime.settings,
    );
    await f.db.orm.update(projects).set({ budgetUsd: 0 }).where(eq(projects.id, f.projectId));
    const forbidden = vi.fn(() => Promise.reject(new Error('No remaining budget.')));
    const failed = await executeEvaluation(executor(forbidden), exhausted.id);
    expect(failed?.results[0]?.outcome).toBe('budget_exceeded');
    expect(forbidden).not.toHaveBeenCalled();
  });
  it('serializes concurrent executors and honors global pause before starting work', async () => {
    const control = await getControl(f.db);
    await setControl(f.db, f.userId, true, control.version);
    const run = await startEvaluation(f.db, f.userId, request(), f.runtime.settings);
    const never = vi.fn(() => Promise.reject(new Error('Fixture model must stay off.')));
    await executeEvaluation(executor(never), run.id);
    expect((await evaluationReport(f.db, f.userId, run.id)).status).toBe('queued');
    const paused = await getControl(f.db);
    await setControl(f.db, f.userId, false, paused.version);
    await Promise.all([
      executeEvaluation(executor(never), run.id),
      executeEvaluation(executor(never), run.id),
    ]);
    expect((await evaluationReport(f.db, f.userId, run.id)).completedCases).toBe(12);
    expect(
      await f.db.orm
        .select()
        .from(evalResults)
        .where(and(eq(evalResults.evalRunId, run.id), eq(evalResults.status, 'done'))),
    ).toHaveLength(12);
    expect(never).not.toHaveBeenCalled();
  });
  it('applies a newly committed send revocation after reading external content and before dispatch', async () => {
    const original = (await readSettings(f.db)).security;
    const run = await startEvaluation(
      f.db,
      f.userId,
      request({ mode: 'configured', suites: ['red-team'], presets: ['balanced'] }),
      f.runtime.settings,
    );
    let calls = 0;
    try {
      const result = await executeEvaluation(
        executor(async (input) => {
          if (++calls === 2) {
            await saveSetting(f.db, {
              namespace: 'security',
              actorId: f.userId,
              expectedVersion: original.version,
              value: {
                ...original.value,
                rules: [
                  {
                    id: 'eval-current-send-revocation',
                    scope: { type: 'global' },
                    match: { tool: 'gmail.send' },
                    action: 'deny',
                    when: [],
                  },
                ],
              },
            });
          }
          return generated(input);
        }),
        run.id,
      );
      expect(result).toMatchObject({ status: 'completed', totalCases: 10, passedCases: 10 });
      expect(
        result!.results[0]!.decisions.find((item) => item.tool === 'gmail.send'),
      ).toMatchObject({ action: 'deny', ruleId: 'eval-current-send-revocation', tainted: true });
      expect(
        result!.results.flatMap((item) => item.dispatches).every((item) => item.effect === 'read'),
      ).toBe(true);
      expect(
        result!.results.every(
          (item) => item.liveDispatches === 0 && item.unauthorizedEffects === 0,
        ),
      ).toBe(true);
      expect(result!.costUsd).toBeGreaterThan(0);
    } finally {
      const current = (await readSettings(f.db)).security;
      await saveSetting(f.db, {
        namespace: 'security',
        actorId: f.userId,
        expectedVersion: current.version,
        value: original.value,
      });
    }
  });
});
