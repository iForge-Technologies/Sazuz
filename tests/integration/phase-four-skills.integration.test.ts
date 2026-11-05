import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshSettings, type SettingsDocument } from '@sazuz/config/settings';
import {
  createMission,
  createProject,
  getMission,
  skills,
  skillSelections,
  styleProfiles,
  projects,
  costLedger,
  executionControl,
  workKey,
} from '@sazuz/db';
import { skillVersionSchema } from '@sazuz/core/skills';
import { secretRedactor } from '@sazuz/vault';
import {
  acceptStyle,
  createSkillTools,
  formatSkill,
  listSkills,
  listStyleProfiles,
  previewStyle,
  saveSkill,
  selectSkill,
  skillVersion,
  skillsContext,
} from '../../packages/skills/src/index.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { ToolRegistry, defineTool } from '../../packages/tools/src/index.js';
import type { GenerateRequest } from '../../packages/llm/src/contracts.js';
import { createFixtureRouter } from './phase-three-runtime-worker.js';
import { phaseFourFixture } from './phase-four-fixture.js';

const marker = 'SELECTED_SKILL_ORCHID_MARKER';
function document(body = marker, name = 'fixture-style') {
  return formatSkill(
    {
      name,
      description: 'Use this skill to draft a short fixture.',
      version: '1.0.0',
      inputs: { type: 'object', properties: {} },
      tools: ['files.fixture_send'],
      permissions: ['read', 'send'],
    },
    body,
  ).markdown;
}
const style = {
  traits: ['Use concise sentences.', 'Start with the requested action.'],
  greeting: 'Hi',
  signOff: 'Thanks',
  sampleDraft: 'Hi Jo, could you join a short planning meeting tomorrow? Thanks.',
};
describe('Phase 4 progressive skill revisions and style review', () => {
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
    projectId = (await createProject(f.db, f.userId, { name: 'Skill case' })).id;
    settings = freshSettings();
  });
  afterAll(async () => {
    await f?.close();
  });
  function mission() {
    return createMission(
      f.db,
      f.userId,
      {
        projectId,
        goal: 'Use fixture-style to prepare the requested draft.',
        agent: 'researcher',
        requestId: randomUUID(),
      },
      { maxSteps: 8, maxCostUsd: 1, maxWallTimeSeconds: 120 },
    );
  }
  function executor(
    router = createFixtureRouter({ toolName: 'skills.load', args: { name: 'fixture-style' } }),
    tools = new ToolRegistry(createSkillTools(f.db)),
  ) {
    return createDurableExecutor({
      database: f.db,
      workerId: workKey('wrk'),
      dataDir: f.directory,
      getSettings: () => settings,
      tools,
      router: () => router,
      buildContext: (input, messages) => skillsContext(f.db, input.userId, messages),
    });
  }
  it('keeps full bodies out of the initial prompt and loads the complete selected body, including beyond ordinary observation limits', async () => {
    const body =
      marker + '\n' + 'A bounded procedure detail. '.repeat(550) + '\nEND_OF_SELECTED_SKILL';
    const skill = await saveSkill(f.db, f.userId, {
      markdown: document(body),
      expectedRevision: 0,
    });
    const catalog = await listSkills(f.db, f.userId);
    expect(catalog.filter((entry) => entry.source === 'builtin')).toHaveLength(5);
    expect(JSON.stringify(catalog)).not.toContain(marker);
    const value = await mission();
    await executor().execute(value.run.id);
    const result = await getMission(f.db, f.userId, value.id);
    expect(result?.mission.run.status).toBe('completed');
    const prompts = result!.steps
      .filter((step) => step.kind === 'assistant')
      .map((step) => step.prompt!);
    expect(prompts[0]).toContain('fixture-style');
    expect(prompts[0]).not.toContain(marker);
    expect(prompts[1]).toContain(marker);
    expect(prompts[1]).toContain('END_OF_SELECTED_SKILL');
    expect(prompts[1]).toContain(skill.sha256);
    expect(prompts[1]).toContain('<untrusted>');
    expect(result?.mission.run.tainted).toBe(true);
  });
  it('pins selected revisions through replay, preserves immutable history and excludes disabled or another owner’s skills', async () => {
    const first = await saveSkill(f.db, f.userId, { markdown: document(), expectedRevision: 0 });
    const value = await mission();
    const runner = executor();
    await runner.execute(value.run.id);
    const [selection] = await f.db.orm
      .select()
      .from(skillSelections)
      .where(eq(skillSelections.runId, value.run.id));
    const second = await saveSkill(
      f.db,
      f.userId,
      { markdown: document('NEW_VERSION_BODY'), expectedRevision: 1 },
      first.id,
    );
    const pinned = await selectSkill(
      f.db,
      f.userId,
      { name: first.name },
      { key: selection!.key, runId: value.run.id },
    );
    expect(pinned).toMatchObject({ revision: 1, sha256: first.sha256 });
    expect(pinned.markdown).toContain(marker);
    expect((await skillVersion(f.db, f.userId, first.id)).revision).toBe(2);
    expect(second.sha256).not.toBe(first.sha256);
    const before = (await getMission(f.db, f.userId, value.id))!.steps;
    await runner.execute(value.run.id);
    expect((await getMission(f.db, f.userId, value.id))!.steps).toEqual(before);
    await expect(skillVersion(f.db, 'another-owner', first.id)).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
    });
    await saveSkill(
      f.db,
      f.userId,
      { markdown: second.markdown, expectedRevision: 2, enabled: false },
      first.id,
    );
    expect(JSON.stringify((await skillsContext(f.db, f.userId, [])).messages)).not.toContain(
      first.name,
    );
    await expect(
      selectSkill(f.db, f.userId, { name: first.name }, { runId: value.run.id, key: randomUUID() }),
    ).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
  });
  it('applies the local-model restriction only after loading private skill instructions', async () => {
    await saveSkill(f.db, f.userId, {
      markdown: document(),
      expectedRevision: 0,
      privateOnly: true,
    });
    const prompts: GenerateRequest[] = [];
    const value = await mission();
    await executor(
      createFixtureRouter({
        toolName: 'skills.load',
        args: { name: 'fixture-style' },
        onGenerate: (request) => prompts.push(request),
      }),
    ).execute(value.run.id);
    expect(prompts[0]?.privateOnly).toBe(false);
    expect(prompts.at(-1)?.privateOnly).toBe(true);
    expect(JSON.stringify(prompts[0]?.messages)).not.toContain(marker);
  });
  it('does not turn skill permissions into approval for a consequential tool', async () => {
    await saveSkill(f.db, f.userId, {
      markdown: document('Prepare a message. Sending still requires approval.'),
      expectedRevision: 0,
    });
    const send = vi.fn<() => Promise<{ sent: boolean }>>().mockResolvedValue({ sent: true });
    const tools = new ToolRegistry([
      ...createSkillTools(f.db),
      defineTool({
        name: 'files.fixture_send',
        description: 'Fixture external send',
        effect: 'send',
        scope: 'external',
        input: z.strictObject({}),
        output: z.strictObject({ sent: z.boolean() }),
        run: send,
      }),
    ]);
    const load = createFixtureRouter({ toolName: 'skills.load', args: { name: 'fixture-style' } });
    const outbound = createFixtureRouter({ toolName: 'files.fixture_send' });
    const router = {
      ...load,
      generate: (request: GenerateRequest) =>
        request.messages.some((message) => message.role === 'tool')
          ? outbound.generate({
              ...request,
              messages: request.messages.filter((message) => message.role !== 'tool'),
            })
          : load.generate(request),
    };
    const value = await mission();
    await executor(router, tools).execute(value.run.id);
    expect((await getMission(f.db, f.userId, value.id))?.mission.run.status).toBe(
      'waiting_approval',
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('generates a tool-free Fast style preview, charges once, stores no source samples and requires explicit acceptance', async () => {
    const prompts: GenerateRequest[] = [];
    const router = createFixtureRouter({
      plan: style,
      costUsd: 0.002,
      onGenerate: (request) => prompts.push(request),
    });
    const sample = 'Hi Jo, can you check the schedule this afternoon? Thanks for taking a look.';
    const input = { requestId: randomUUID(), samples: [sample], privateOnly: true };
    const options = {
      database: f.db,
      userId: f.userId,
      input,
      getSettings: () => settings,
      router,
    };
    const preview = await previewStyle(options);
    expect(preview.status).toBe('preview');
    expect(preview.costUsd).toBe(0.002);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ role: 'fast', privateOnly: true });
    expect(prompts[0]?.tools).toEqual([]);
    expect(JSON.stringify(prompts[0]?.messages)).toContain('<untrusted>');
    expect((await listSkills(f.db, f.userId)).some((entry) => entry.name === 'writing-style')).toBe(
      false,
    );
    expect(JSON.stringify(await f.db.orm.select().from(styleProfiles))).not.toContain(sample);
    expect((await previewStyle(options)).id).toBe(preview.id);
    expect(prompts).toHaveLength(1);
    const [first, duplicate] = await Promise.all([
      acceptStyle(f.db, f.userId, preview.id),
      acceptStyle(f.db, f.userId, preview.id),
    ]);
    expect(first.id).toBe(duplicate.id);
    expect(first.revision).toBe(1);
    expect(first.privateOnly).toBe(true);
    expect((await listStyleProfiles(f.db, f.userId))[0]?.status).toBe('accepted');
    expect(
      await f.db.orm.select().from(costLedger).where(eq(costLedger.agentId, 'style-preview')),
    ).toHaveLength(1);
  });
  it('waits for brief spending contention before generating and records only one model call', async () => {
    const prompts: GenerateRequest[] = [];
    const options = {
      database: f.db,
      userId: f.userId,
      input: {
        requestId: randomUUID(),
        samples: ['A sufficiently long sample while background extraction is running.'],
      },
      getSettings: () => settings,
      router: createFixtureRouter({ plan: style, onGenerate: (request) => prompts.push(request) }),
    };
    const holder = await f.db.pool.connect();
    await holder.query('SELECT pg_advisory_lock(72839102)');
    let finished = false;
    const pending = previewStyle(options).then((profile) => {
      finished = true;
      return profile;
    });
    try {
      await vi.waitFor(async () => {
        const [profile] = await f.db.orm
          .select()
          .from(styleProfiles)
          .where(eq(styleProfiles.requestId, options.input.requestId));
        expect(profile?.status).toBe('generating');
      });
      await delay(150);
      expect(finished).toBe(false);
      expect(prompts).toHaveLength(0);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(72839102)');
      holder.release();
      await pending;
    }
    const profile = await pending;
    expect(profile.status).toBe('preview');
    expect((await previewStyle(options)).id).toBe(profile.id);
    expect(prompts).toHaveLength(1);
  });
  it('reports prolonged contention without billing and starts only an explicitly new preview', async () => {
    const prompts: GenerateRequest[] = [];
    const options = {
      database: f.db,
      userId: f.userId,
      input: {
        requestId: randomUUID(),
        samples: ['A sufficiently long sample while another run holds the spending allowance.'],
      },
      getSettings: () => settings,
      router: createFixtureRouter({
        plan: style,
        costUsd: 0.002,
        onGenerate: (request) => prompts.push(request),
      }),
    };
    const holder = await f.db.pool.connect();
    await holder.query('SELECT pg_advisory_lock(72839102)');
    try {
      expect(await previewStyle(options)).toMatchObject({
        status: 'failed',
        errorCode: 'STYLE_BUSY',
        costUsd: 0,
      });
      expect(prompts).toHaveLength(0);
      expect(await f.db.orm.select().from(costLedger)).toHaveLength(0);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(72839102)');
      holder.release();
    }
    expect(await previewStyle(options)).toMatchObject({
      status: 'failed',
      errorCode: 'STYLE_BUSY',
    });
    expect(prompts).toHaveLength(0);
    expect(
      await previewStyle({
        ...options,
        input: { ...options.input, requestId: randomUUID() },
      }),
    ).toMatchObject({ status: 'preview', costUsd: 0.002 });
    expect(prompts).toHaveLength(1);
  });
  it('keeps failed previews inactive, refuses changed replay inputs and respects global pause', async () => {
    const router = createFixtureRouter({ plan: style });
    const input = {
      requestId: randomUUID(),
      samples: ['A sufficiently long writing sample for this test.'],
    };
    await f.db.orm.insert(executionControl).values({ paused: true });
    const options = {
      database: f.db,
      userId: f.userId,
      input,
      getSettings: () => settings,
      router,
    };
    const preview = await previewStyle(options);
    expect(preview).toMatchObject({ status: 'failed', errorCode: 'STYLE_BUDGET' });
    await expect(acceptStyle(f.db, f.userId, preview.id)).rejects.toMatchObject({
      code: 'SKILL_CONFLICT',
    });
    await expect(
      previewStyle({
        ...options,
        input: { ...input, samples: ['A different sufficiently long sample for this test.'] },
      }),
    ).rejects.toMatchObject({ code: 'STYLE_CONFLICT' });
    await f.db.orm.insert(styleProfiles).values({
      id: workKey('sty'),
      userId: f.userId,
      requestId: randomUUID(),
      inputHash: '0'.repeat(64),
      privateOnly: true,
      createdAt: new Date(Date.now() - 120000),
    });
    expect(
      (await listStyleProfiles(f.db, f.userId)).some(
        (entry) => entry.errorCode === 'STYLE_INTERRUPTED',
      ),
    ).toBe(true);
  });
  it('authenticates and validates editor APIs, keeps built-ins read-only and never returns secret canaries', async () => {
    expect((await f.request('GET', '/api/skills', undefined, false)).statusCode).toBe(401);
    const input = { markdown: document(), expectedRevision: 0 };
    expect(
      (await f.request('POST', '/api/skills', input, true, 'https://attacker.test')).statusCode,
    ).toBe(403);
    const response = await f.request('POST', '/api/skills', input);
    expect(response.statusCode).toBe(200);
    const first = skillVersionSchema.parse(response.json());
    expect((await f.request('PUT', `/api/skills/${first.id}`, input)).statusCode).toBe(409);
    const edited = await f.request('PUT', `/api/skills/${first.id}`, {
      markdown: document('NEW_API_REVISION'),
      expectedRevision: 1,
    });
    expect(edited.statusCode).toBe(200);
    expect((await f.request('GET', `/api/skills/${first.id}?revision=1`)).body).toContain(marker);
    expect(
      (await f.request('GET', `/api/skills/${first.id}/versions`)).json<unknown[]>(),
    ).toHaveLength(2);
    expect((await f.request('GET', '/api/skills')).body).not.toContain(marker);
    const builtin = (await listSkills(f.db, f.userId)).find((entry) => entry.source === 'builtin')!;
    expect(
      (
        await f.request('PUT', `/api/skills/${builtin.id}`, {
          ...input,
          expectedRevision: builtin.revision,
        })
      ).statusCode,
    ).toBe(409);
    const canary = 'style-api-secret-canary-963417';
    secretRedactor.register(canary);
    expect(
      (
        await f.request('POST', '/api/skills/style/preview', {
          requestId: randomUUID(),
          samples: [`Example ${canary} sample.`],
        })
      ).statusCode,
    ).toBe(400);
    const rejected = await f.request('POST', '/api/skills', {
      ...input,
      markdown: input.markdown + canary,
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).not.toContain(canary);
    expect(f.logLines.join('')).not.toContain(canary);
    expect(
      await f.db.orm
        .select()
        .from(skills)
        .where(and(eq(skills.userId, f.userId), eq(skills.name, 'writing-style'))),
    ).toEqual([]);
  });
});
