import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  browserRecordings,
  browserSessions,
  costLedger,
  learningDrafts,
  learnedSkillVersions,
  runs,
  setControl,
  getControl,
} from '@sazuz/db';
import { recordingSchema, learnedVersionSchema } from '@sazuz/core/learning';
import {
  compileRecording,
  generateLearnedSkill,
  listLearningDrafts,
  saveSkill,
  skillsContext,
} from '../../packages/skills/src/index.js';
import { recording, stopRecording } from '@sazuz/browser';
import { createFixtureRouter } from './phase-three-runtime-worker.js';
import { learningFixture } from './phase-nine-fixture.js';

describe('Phase 9 recording and reviewed generation', () => {
  let f: Awaited<ReturnType<typeof learningFixture>>;
  beforeAll(async () => {
    f = await learningFixture();
  });
  afterAll(async () => {
    await f?.close();
  });
  it('captures an actual eight-step demonstration, deduplicates input, strips URL data and saves an immutable reviewed skill', async () => {
    const demo = await f.eightSteps();
    const events = demo.recording.events.filter((event) => event.replay);
    expect(events.map((event) => event.kind)).toEqual([
      'navigate',
      'fill',
      'fill',
      'select',
      'click',
      'fill',
      'click',
      'click',
    ]);
    expect(events[0]?.url).toBe('https://fixture.example/learn');
    const serialized = JSON.stringify(demo.recording);
    for (const value of [
      'Original project',
      'Original client',
      'Original notes',
      'discard=this',
      'fragment',
    ])
      expect(serialized).not.toContain(value);
    expect(
      events
        .filter((event) => event.target)
        .every((event) => event.target!.locators.length >= 2 && event.target!.crop === 'withheld'),
    ).toBe(true);
    const input = {
      requestId: randomUUID(),
      name: 'demo-project',
      parameters: Object.fromEntries(
        events
          .filter((event) => ['fill', 'select'].includes(event.kind))
          .map((event) => [event.id, event.target!.name.toLowerCase()]),
      ),
      loops: [],
    };
    const program = compileRecording(demo.recording.site, events, input);
    const generated = vi.fn();
    const router = createFixtureRouter({
      plan: {
        description: 'Create a project from reviewed inputs.',
        intents: program.steps.flatMap((step) =>
          step.kind === 'action' ? [{ id: step.id, text: step.intent }] : [],
        ),
      },
      costUsd: 0.001,
      onGenerate: (request) => {
        generated();
        expect(request.privateOnly).toBe(true);
        expect(request.tools).toEqual([]);
        expect(JSON.stringify(request.messages)).toContain('<untrusted>');
        expect(JSON.stringify(request.messages)).not.toContain('Original project');
      },
    });
    const generate = () =>
      generateLearnedSkill({
        database: f.db,
        userId: f.userId,
        recordingId: demo.record.id,
        input,
        getSettings: () => f.runtime.settings,
        router,
      });
    const draft = await generate();
    expect(draft.status, draft.errorCode ?? 'generation status').toBe('ready');
    expect(draft.costUsd).toBeCloseTo(0.001);
    expect(await generate()).toEqual(draft);
    expect(generated).toHaveBeenCalledTimes(1);
    await expect(
      generateLearnedSkill({
        database: f.db,
        userId: f.userId,
        recordingId: demo.record.id,
        input: { ...input, name: 'changed' },
        getSettings: () => f.runtime.settings,
        router,
      }),
    ).rejects.toThrow();
    const body = {
      draftId: draft.id,
      expectedRevision: 0,
      description: draft.description,
      program: draft.program,
      enabled: true,
    };
    const response = await f.request('POST', '/api/skills/learned', body);
    expect(response.statusCode, response.body).toBe(200);
    const saved = learnedVersionSchema.parse(response.json());
    expect(
      learnedVersionSchema.parse((await f.request('POST', '/api/skills/learned', body)).json()),
    ).toEqual(saved);
    expect(saved.program.steps).toHaveLength(8);
    expect(saved.skill.markdown).toContain(saved.programHash);
    expect(
      await f.db.orm
        .select()
        .from(learnedSkillVersions)
        .where(eq(learnedSkillVersions.skillId, saved.skill.id)),
    ).toHaveLength(1);
    await expect(
      saveSkill(
        f.db,
        f.userId,
        { markdown: saved.skill.markdown, expectedRevision: 1 },
        saved.skill.id,
      ),
    ).rejects.toThrow();
    const context = await skillsContext(f.db, f.userId, []);
    expect(JSON.stringify(context.messages)).toContain('demo-project');
    expect(JSON.stringify(context.messages)).not.toContain(saved.programHash);
    expect(
      await f.db.orm.select().from(costLedger).where(eq(costLedger.runId, draft.id)),
    ).toHaveLength(1);
    await f.client({ mode: 'close', sessionId: demo.sessionId });
  }, 60000);
  it('requires authenticated owner input, CSRF and explicit control; start/stop retries do not duplicate recordings', async () => {
    const demo = await f.recorded('Control rules');
    expect(
      (
        await f.request(
          'POST',
          `/api/browser/sessions/${demo.sessionId}/recording`,
          demo.start,
          false,
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.request(
          'POST',
          `/api/browser/sessions/${demo.sessionId}/recording`,
          demo.start,
          true,
          'https://evil.example',
        )
      ).statusCode,
    ).toBe(403);
    expect(
      recordingSchema.parse(
        (
          await f.request('POST', `/api/browser/sessions/${demo.sessionId}/recording`, demo.start)
        ).json(),
      ).id,
    ).toBe(demo.record.id);
    await expect(recording(f.db, 'other-owner', demo.record.id)).rejects.toThrow();
    await expect(f.client({ mode: 'handback', sessionId: demo.sessionId })).rejects.toThrow();
    await setControl(f.db, f.userId, true, (await getControl(f.db)).version);
    await expect(
      f.service.engine.input(demo.sessionId, { type: 'text', text: 'Blocked input' }),
    ).rejects.toThrow();
    await setControl(f.db, f.userId, false, (await getControl(f.db)).version);
    const stopped = await demo.stop();
    expect(await stopRecording(f.db, f.userId, stopped.id, stopped.version)).toEqual(stopped);
    await demo.fill('Project', 'After recording');
    expect(await recording(f.db, f.userId, stopped.id)).toEqual(stopped);
    await f.client({ mode: 'close', sessionId: demo.sessionId });
  });
  it('excludes credentials and challenge actions and marks service loss as interrupted', async () => {
    const demo = await f.recorded('Sensitive capture');
    await demo.page.goto('https://fixture.example/login');
    await demo.fill('Password', 'phase9-password-canary-8451973');
    await demo.key('Tab');
    const value = await recording(f.db, f.userId, demo.record.id);
    expect(value.omitted).toBeGreaterThan(0);
    expect(value.events.filter((event) => event.replay)).toHaveLength(1);
    expect(JSON.stringify(value)).not.toContain('phase9-password-canary');
    await f.client({ mode: 'close', sessionId: demo.sessionId });
    expect((await recording(f.db, f.userId, demo.record.id)).status).toBe('interrupted');
    expect(f.logLines.join('\n')).not.toContain('phase9-password-canary');
  });
  it('bounds recordings and never retries failed, billed or interrupted generation', async () => {
    const demo = await f.recorded('Bounded capture');
    const first = demo.record.events[0]!;
    await f.db.orm
      .update(browserRecordings)
      .set({
        events: Array.from({ length: 100 }, (_, index) => ({ ...first, id: `e${index + 1}` })),
      })
      .where(eq(browserRecordings.id, demo.record.id));
    await demo.fill('Project', 'Extra value');
    expect((await recording(f.db, f.userId, demo.record.id)).status).toBe('interrupted');
    await f.client({ mode: 'close', sessionId: demo.sessionId });
    const valid = await f.recorded('Generation failure');
    await valid.fill('Project', 'Sample input');
    const stopped = await valid.stop();
    const input = { requestId: randomUUID(), name: 'failed-generation' };
    const called = vi.fn();
    const base = createFixtureRouter({ costUsd: 0.003, onGenerate: called });
    const router = {
      generateObject: async (...args: Parameters<typeof base.generateObject>) => {
        await base.generate(args[0]);
        throw new Error('Provider failed after reporting usage.');
      },
    };
    const generate = () =>
      generateLearnedSkill({
        database: f.db,
        userId: f.userId,
        recordingId: stopped.id,
        input,
        getSettings: () => f.runtime.settings,
        router,
      });
    const failed = await generate();
    expect(failed.status).toBe('failed');
    expect(failed.costUsd).toBeCloseTo(0.003);
    await generate();
    expect(called).toHaveBeenCalledTimes(1);
    await f.db.orm
      .update(learningDrafts)
      .set({ status: 'generating', createdAt: new Date(Date.now() - 100000) })
      .where(eq(learningDrafts.id, failed.id));
    expect(
      (await listLearningDrafts(f.db, f.userId)).find((item) => item.id === failed.id)?.errorCode,
    ).toBe('LEARNING_INTERRUPTED');
    await f.client({ mode: 'close', sessionId: valid.sessionId });
    await f.db.orm
      .update(runs)
      .set({ status: 'cancelled', claimKey: null, workerId: null })
      .where(eq(runs.claimKey, f.claimKey));
    expect(
      await f.db.orm
        .select()
        .from(browserSessions)
        .where(
          and(eq(browserSessions.status, 'active'), eq(browserSessions.projectId, f.projectId)),
        ),
    ).toHaveLength(0);
  });
});
