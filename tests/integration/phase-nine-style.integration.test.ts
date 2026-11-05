import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshSettings, type SettingsDocument } from '@sazuz/config/settings';
import {
  costLedger,
  createMission,
  createProject,
  executionControl,
  getMission,
  projects,
  runs,
  skills,
  skillSelections,
  styleComparisons,
  styleProfiles,
  toolCalls,
  valueHash,
  workKey,
} from '@sazuz/db';
import { styleComparisonSchema } from '@sazuz/core/style';
import type { GenerateRequest } from '../../packages/llm/src/contracts.js';
import type { ModelRouter } from '../../packages/llm/src/router.js';
import { secretRedactor } from '@sazuz/vault';
import {
  acceptStyle,
  compareStyle,
  listStyleComparisons,
  listStyleSources,
  previewSentStyle,
  previewStyle,
  saveSkill,
  skillVersion,
  styleComparison,
  styleContext,
  voteStyleComparison,
} from '../../packages/skills/src/index.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { ToolRegistry, defineTool } from '../../packages/tools/src/index.js';
import { createFixtureRouter } from './phase-three-runtime-worker.js';
import { phaseFourFixture } from './phase-four-fixture.js';

const marker = 'ORCHID_STYLE_MARKER';
const analysis = {
  traits: [`${marker}: use short direct sentences.`],
  greeting: 'Hi',
  signOff: 'Thanks',
  sampleDraft: 'Hi Jo, can we review the plan tomorrow? Thanks.',
};
const task = 'Draft a short message inviting Jo to review the project plan tomorrow.';
describe('Phase 9 consented style, fresh drafting context and blind checks', () => {
  let f: Awaited<ReturnType<typeof phaseFourFixture>>,
    projectId: string,
    settings: SettingsDocument;
  beforeAll(async () => {
    f = await phaseFourFixture();
  });
  beforeEach(async () => {
    await f.db.orm.delete(styleProfiles).where(eq(styleProfiles.userId, f.userId));
    await f.db.orm.delete(skills).where(eq(skills.userId, f.userId));
    await f.db.orm.delete(projects).where(eq(projects.userId, f.userId));
    await f.db.orm.delete(costLedger);
    await f.db.orm.delete(executionControl);
    projectId = (await createProject(f.db, f.userId, { name: 'Style checks' })).id;
    settings = freshSettings();
  });
  afterAll(async () => {
    await f?.close();
  });
  function mission(goal = task, project = projectId) {
    return createMission(
      f.db,
      f.userId,
      { projectId: project, goal, agent: 'researcher', requestId: randomUUID() },
      { maxSteps: 8, maxCostUsd: 1, maxWallTimeSeconds: 120 },
    );
  }
  async function accepted(privateOnly = true) {
    const preview = await previewStyle({
      database: f.db,
      userId: f.userId,
      input: {
        requestId: randomUUID(),
        samples: ['Hi Jo, can you look at the plan this afternoon? Thanks.'],
        privateOnly,
      },
      getSettings: () => settings,
      router: createFixtureRouter({ plan: analysis, costUsd: 0.002 }),
    });
    expect(preview.status).toBe('preview');
    return acceptStyle(f.db, f.userId, preview.id);
  }
  async function receipt(
    options: {
      tool?: string;
      result?: unknown;
      status?: string;
      project?: string;
      text?: string;
      privateOnly?: boolean;
      messageId?: string;
    } = {},
  ) {
    const value = await mission('Send the reviewed message.', options.project ?? projectId);
    await f.db.orm
      .update(runs)
      .set({ checkpoint: { loop: { privateOnly: options.privateOnly ?? false } } })
      .where(eq(runs.id, value.run.id));
    const args = {
      accountId: 'official-mail',
      subject: 'Project invitation',
      text:
        options.text ?? 'Hi Jo, could you review the plan after lunch? Thanks for taking a look.',
      to: ['jo@example.test'],
    };
    const id = workKey('call');
    await f.db.orm.insert(toolCalls).values({
      id,
      runId: value.run.id,
      idempotencyKey: randomUUID(),
      toolName: options.tool ?? 'gmail.send',
      args,
      argsHash: valueHash(args),
      effect: 'send',
      status: options.status ?? 'done',
      result: options.result ?? {
        output: { id: randomUUID(), messageId: options.messageId ?? randomUUID() },
        untrusted: true,
      },
    });
    return { id, args, mission: value };
  }
  function comparisonRouter(hook?: (request: GenerateRequest, call: number) => Promise<void>) {
    const requests: GenerateRequest[] = [];
    const router: Pick<ModelRouter, 'generateObject'> = {
      async generateObject<T>(
        request: GenerateRequest,
        schema: z.ZodType<T>,
        options?: { maxAttempts?: 1 | 2 },
      ) {
        requests.push(request);
        expect(options).toEqual({ maxAttempts: 1 });
        expect(request.tools).toEqual([]);
        expect(request.maxOutputTokens).toBe(1800);
        expect(JSON.stringify(request.messages)).toContain('<untrusted>');
        await hook?.(request, requests.length);
        const styled = JSON.stringify(request.messages).includes(marker);
        return createFixtureRouter({
          plan: {
            draft: styled
              ? 'Hi Jo, can we review the plan tomorrow? Thanks.'
              : 'Dear Jo, please join a review of the project plan tomorrow.',
          },
          costUsd: 0.002,
        }).generateObject(request, schema);
      },
    };
    return { router, requests };
  }
  function options(
    router: Pick<ModelRouter, 'generateObject'>,
    input = { requestId: randomUUID(), projectId, task, privateOnly: false },
  ) {
    return { database: f.db, userId: f.userId, input, getSettings: () => settings, router };
  }
  it('lists only owned confirmed official sends and stores consented excerpt hashes without sample copies', async () => {
    const first = await receipt({ privateOnly: true }),
      second = await receipt({
        tool: 'email.send',
        result: {
          output: {
            messageId: randomUUID(),
            recipientStatus: 'confirmed',
            accepted: ['jo@example.test'],
            rejected: [],
          },
          untrusted: true,
        },
      });
    await receipt({ tool: 'gmail.draft' });
    await receipt({ status: 'intent' });
    await receipt({
      result: { output: { confirmedByUser: true, note: 'Sent' }, untrusted: false },
    });
    await receipt({ result: { output: { simulated: true }, untrusted: true } });
    await receipt({
      tool: 'email.send',
      result: {
        output: { messageId: 'unknown', recipientStatus: 'unknown', accepted: [], rejected: [] },
        untrusted: true,
      },
    });
    const otherProject = (await createProject(f.db, f.userId, { name: 'Different project' })).id;
    const foreign = await receipt({ project: otherProject });
    const listed = await listStyleSources(f.db, f.userId, projectId);
    expect(listed.map((item) => item.callId).sort()).toEqual([first.id, second.id].sort());
    expect(JSON.stringify(listed)).not.toContain(first.args.text);
    await expect(listStyleSources(f.db, 'another-owner', projectId)).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
    });
    const prompts: GenerateRequest[] = [];
    const router = createFixtureRouter({
      plan: analysis,
      costUsd: 0.002,
      onGenerate: (request) => prompts.push(request),
    });
    const input = {
      requestId: randomUUID(),
      projectId,
      callIds: [first.id, second.id],
      consent: true,
      privateOnly: false,
    };
    const preview = await previewSentStyle({ ...options(router), input });
    expect(preview).toMatchObject({
      status: 'preview',
      privateOnly: true,
      projectId,
      costUsd: 0.002,
    });
    expect(preview.sources).toHaveLength(2);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ privateOnly: true, tools: [] });
    expect(JSON.stringify(prompts[0]?.messages)).toContain(first.args.text);
    expect(
      (
        await previewSentStyle({
          ...options(router),
          input: { ...input, callIds: [second.id, first.id] },
        })
      ).id,
    ).toBe(preview.id);
    expect(prompts).toHaveLength(1);
    const stored = (
      await f.db.orm.select().from(styleProfiles).where(eq(styleProfiles.id, preview.id))
    )[0]!;
    expect(JSON.stringify(stored)).not.toContain(first.args.text);
    expect(
      (await f.db.orm.select().from(costLedger).where(eq(costLedger.runId, preview.id)))[0]
        ?.projectId,
    ).toBe(projectId);
    await expect(
      previewSentStyle({ ...options(router), input: { ...input, callIds: [foreign.id] } }),
    ).rejects.toMatchObject({ code: 'STYLE_SOURCE_NOT_FOUND' });
    expect(
      (await f.request('POST', '/api/skills/style/sent-preview', { ...input, consent: false }))
        .statusCode,
    ).toBe(400);
    expect(
      (await f.request('GET', `/api/skills/style/sources?projectId=${projectId}`, undefined, false))
        .statusCode,
    ).toBe(401);
  });
  it('bounds selected excerpts, rejects duplicate send receipts, and respects project budgets before inference', async () => {
    const shared = randomUUID();
    const first = await receipt({
      text: 'A long but bounded writing sample. '.repeat(300),
      messageId: shared,
    });
    const duplicate = await receipt({ messageId: shared });
    expect(await listStyleSources(f.db, f.userId, projectId)).toHaveLength(1);
    const router = createFixtureRouter({ plan: analysis, costUsd: 0.002 });
    const input = {
      requestId: randomUUID(),
      projectId,
      callIds: [first.id, duplicate.id],
      consent: true,
      privateOnly: false,
    };
    await expect(previewSentStyle({ ...options(router), input })).rejects.toMatchObject({
      code: 'STYLE_SOURCE_NOT_FOUND',
    });
    const preview = await previewSentStyle({
      ...options(router),
      input: { ...input, callIds: [first.id] },
    });
    expect(preview.sources[0]?.characters).toBe(6000);
    await f.db.orm.update(projects).set({ budgetUsd: 0 }).where(eq(projects.id, projectId));
    const denied = await previewSentStyle({
      ...options(router),
      input: { ...input, requestId: randomUUID(), callIds: [first.id] },
    });
    expect(denied).toMatchObject({ status: 'failed', costUsd: 0 });
  });
  it('loads the current reviewed style only for drafting, pins provenance, copies messages and honors edits and disabling', async () => {
    const first = await accepted(false),
      value = await mission();
    const input = {
      userId: f.userId,
      projectId,
      runId: value.run.id,
      agentId: 'researcher' as const,
      query: task,
    };
    const messages = [{ role: 'system' as const, content: 'Original instructions.' }];
    const initial = await styleContext(f.db, input, messages);
    expect(initial).toMatchObject({ tainted: true, privateOnly: false });
    expect(JSON.stringify(initial.messages)).toContain(marker);
    expect(JSON.stringify(initial.messages)).toContain(first.sha256);
    expect(messages).toEqual([{ role: 'system', content: 'Original instructions.' }]);
    const irrelevant = await styleContext(
      f.db,
      { ...input, query: 'Find the current exchange rate.' },
      messages,
    );
    expect(irrelevant.messages).toEqual(messages);
    const second = await saveSkill(
      f.db,
      f.userId,
      {
        markdown: first.markdown.replace(marker, 'NEW_STYLE_MARKER'),
        expectedRevision: 1,
        privateOnly: true,
      },
      first.id,
    );
    const changed = await styleContext(f.db, input, messages);
    expect(changed).toMatchObject({ tainted: true, privateOnly: true });
    expect(JSON.stringify(changed.messages)).toContain('NEW_STYLE_MARKER');
    expect(JSON.stringify(changed.messages)).not.toContain(marker);
    expect((await skillVersion(f.db, f.userId, first.id, 1)).privateOnly).toBe(true);
    expect(
      await f.db.orm.select().from(skillSelections).where(eq(skillSelections.runId, value.run.id)),
    ).toHaveLength(2);
    await saveSkill(
      f.db,
      f.userId,
      { markdown: second.markdown, expectedRevision: 2, enabled: false, privateOnly: true },
      first.id,
    );
    expect((await styleContext(f.db, input, messages)).messages).toEqual(messages);
    expect(
      (await styleContext(f.db, { ...input, userId: 'another-owner' }, messages)).messages,
    ).toEqual(messages);
  });
  it('propagates private style and taint through durable generation while a send still waits for approval', async () => {
    await accepted();
    const value = await mission(),
      prompts: GenerateRequest[] = [];
    let sent = 0;
    const runner = createDurableExecutor({
      database: f.db,
      workerId: workKey('wrk'),
      dataDir: f.directory,
      getSettings: () => settings,
      tools: new ToolRegistry([
        defineTool({
          name: 'files.fixture_send',
          description: 'Fixture send',
          effect: 'send',
          scope: 'external',
          input: z.strictObject({}),
          output: z.strictObject({ sent: z.boolean() }),
          run: () => {
            sent++;
            return Promise.resolve({ sent: true });
          },
        }),
      ]),
      router: () =>
        createFixtureRouter({
          toolName: 'files.fixture_send',
          onGenerate: (request) => prompts.push(request),
        }),
      buildContext: (input, messages) => styleContext(f.db, input, messages),
    });
    await runner.execute(value.run.id);
    const result = await getMission(f.db, f.userId, value.id);
    expect(result?.mission.run).toMatchObject({ status: 'waiting_approval', tainted: true });
    expect(prompts[0]?.privateOnly).toBe(true);
    expect(JSON.stringify(prompts[0]?.messages)).toContain(marker);
    expect(sent).toBe(0);
  });
  it('conceals randomized assignment, generates once across concurrent retries, and reveals only after a durable fixture vote', async () => {
    const style = await accepted(),
      fixture = comparisonRouter(),
      request = options(fixture.router);
    const [a, b] = await Promise.all([compareStyle(request), compareStyle(request)]);
    expect(a.id).toBe(b.id);
    const ready = await styleComparison(f.db, f.userId, a.id);
    expect(ready).toMatchObject({
      status: 'ready',
      privateOnly: true,
      costUsd: 0.004,
      vote: null,
      reveal: null,
    });
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests.every((r) => r.privateOnly)).toBe(true);
    expect(
      fixture.requests.filter((r) => JSON.stringify(r.messages).includes(marker)),
    ).toHaveLength(1);
    const response = await f.request('GET', `/api/skills/style/comparisons/${a.id}`);
    expect(response.statusCode).toBe(200);
    expect(styleComparisonSchema.parse(response.json()).reveal).toBeNull();
    expect(response.body).not.toMatch(/styledLabel|styledDraft|genericDraft|sha256/);
    const row = (
      await f.db.orm.select().from(styleComparisons).where(eq(styleComparisons.id, a.id))
    )[0]!;
    const vote = { vote: row.styledLabel };
    const saved = await f.request('POST', `/api/skills/style/comparisons/${a.id}/vote`, vote);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      status: 'voted',
      reveal: { preference: 'styled', skillId: style.id, revision: 1 },
    });
    expect(
      (await f.request('POST', `/api/skills/style/comparisons/${a.id}/vote`, vote)).json(),
    ).toEqual(saved.json());
    expect(
      (
        await f.request('POST', `/api/skills/style/comparisons/${a.id}/vote`, {
          vote: row.styledLabel === 'A' ? 'B' : 'A',
        })
      ).statusCode,
    ).toBe(409);
    expect((await compareStyle(request)).status).toBe('voted');
    expect(fixture.requests).toHaveLength(2);
    expect(await f.db.orm.select().from(costLedger).where(eq(costLedger.runId, a.id))).toHaveLength(
      2,
    );
    await expect(
      compareStyle({ ...request, input: { ...request.input, task: task + ' Extra words.' } }),
    ).rejects.toMatchObject({ code: 'STYLE_CHECK_CONFLICT' });
  });
  it('hides partial drafts, keeps billed failure costs, and never regenerates a failed receipt', async () => {
    await accepted();
    const fixture = comparisonRouter();
    let count = 0;
    const router: Pick<ModelRouter, 'generateObject'> = {
      async generateObject(request, schema, opts) {
        const result = await fixture.router.generateObject(request, schema, opts);
        if (++count === 2) throw new Error('Model response failed after billing.');
        return result;
      },
    };
    const request = options(router),
      failed = await compareStyle(request);
    expect(failed).toMatchObject({ status: 'failed', costUsd: 0.004, drafts: null, reveal: null });
    expect((await compareStyle(request)).id).toBe(failed.id);
    expect(count).toBe(2);
    await expect(
      voteStyleComparison(f.db, f.userId, failed.id, { vote: 'A' }),
    ).rejects.toMatchObject({ code: 'STYLE_CHECK_CONFLICT' });
  });
  it('retains interrupted generation and does not reveal a completed first draft or retry an uncertain call', async () => {
    await accepted();
    let reached!: () => void, release!: () => void;
    const atSecond = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = comparisonRouter(async (_request, call) => {
      if (call === 2) {
        reached();
        await pending;
        throw new Error('Interrupted fixture call.');
      }
    });
    const request = options(fixture.router),
      running = compareStyle(request);
    try {
      await atSecond;
      const [inProgress] = await listStyleComparisons(f.db, f.userId, projectId);
      expect(inProgress).toMatchObject({
        status: 'generating',
        drafts: null,
        reveal: null,
        costUsd: 0.002,
      });
      expect((await compareStyle(request)).status).toBe('generating');
      await f.db.orm
        .update(styleComparisons)
        .set({ createdAt: new Date(Date.now() - 100000) })
        .where(eq(styleComparisons.id, inProgress!.id));
      expect(await styleComparison(f.db, f.userId, inProgress!.id)).toMatchObject({
        status: 'failed',
        errorCode: 'STYLE_INTERRUPTED',
        costUsd: 0.002,
      });
    } finally {
      release();
    }
    const result = await running;
    expect(result).toMatchObject({ status: 'failed', drafts: null });
    expect((await compareStyle(request)).id).toBe(result.id);
    expect(fixture.requests).toHaveLength(2);
  });
  it('enforces pause, steps, secrets, ownership, CSRF and a single tie vote', async () => {
    await accepted();
    const fixture = comparisonRouter();
    await f.db.orm
      .update(executionControl)
      .set({ paused: true })
      .where(eq(executionControl.id, 'singleton'));
    expect(await compareStyle(options(fixture.router))).toMatchObject({
      status: 'failed',
      costUsd: 0,
    });
    expect(fixture.requests).toHaveLength(0);
    await f.db.orm.delete(executionControl);
    settings.budgets.value.maxSteps = 1;
    expect(await compareStyle(options(fixture.router))).toMatchObject({
      status: 'failed',
      costUsd: 0.002,
      drafts: null,
    });
    expect(fixture.requests).toHaveLength(1);
    settings = freshSettings();
    const ready = await compareStyle(options(fixture.router));
    expect(
      (
        await f.request(
          'POST',
          `/api/skills/style/comparisons/${ready.id}/vote`,
          { vote: 'tie' },
          true,
          'https://other.example',
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await f.request('GET', `/api/skills/style/comparisons/${ready.id}`, undefined, false))
        .statusCode,
    ).toBe(401);
    await expect(styleComparison(f.db, 'another-owner', ready.id)).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
    });
    const tie = await voteStyleComparison(f.db, f.userId, ready.id, { vote: 'tie' });
    expect(tie.reveal?.preference).toBe('tie');
    const secret = 'phase-nine-secret-style-canary-2849736';
    secretRedactor.register(secret);
    await expect(
      compareStyle({
        ...options(fixture.router),
        input: { requestId: randomUUID(), projectId, task: `${task} ${secret}` },
      }),
    ).rejects.toMatchObject({ code: 'SKILL_SECRET' });
    expect(
      JSON.stringify(
        await f.db.orm
          .select()
          .from(styleComparisons)
          .where(
            and(eq(styleComparisons.userId, f.userId), eq(styleComparisons.projectId, projectId)),
          ),
      ),
    ).not.toContain(secret);
  });
  it('stops comparison if the reviewed style is revoked between draft requests', async () => {
    const style = await accepted();
    const fixture = comparisonRouter(async (_request, call) => {
      if (call === 1)
        await saveSkill(
          f.db,
          f.userId,
          { markdown: style.markdown, expectedRevision: 1, enabled: false, privateOnly: true },
          style.id,
        );
    });
    expect(await compareStyle(options(fixture.router))).toMatchObject({
      status: 'failed',
      errorCode: 'STYLE_CHECK_CONFLICT',
      drafts: null,
      costUsd: 0.002,
    });
    expect(fixture.requests).toHaveLength(1);
    await expect(compareStyle(options(fixture.router))).rejects.toMatchObject({
      code: 'STYLE_UNAVAILABLE',
    });
  });
});
