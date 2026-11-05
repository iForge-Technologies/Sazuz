import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshSettings, type SettingsDocument } from '@sazuz/config/settings';
import {
  recipeInstallationSchema,
  recipeTemplateSchema,
  type RecipePreviewInput,
} from '@sazuz/core/recipes';
import {
  auditLog,
  createProject,
  getMission,
  missions,
  projects,
  queueOutbox,
  recipeInstallations,
  triggers,
  workKey,
} from '@sazuz/db';
import { secretRedactor } from '@sazuz/vault';
import { createAutomationRunner, triggerMission } from '../../packages/runtime/src/automation.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import {
  installRecipe,
  listRecipeInstallations,
  previewRecipe,
} from '../../packages/runtime/src/recipes.js';
import { defineTool, ToolRegistry } from '../../packages/tools/src/index.js';
import { createFixtureRouter, fixtureMailAccount } from './phase-three-runtime-worker.js';
import { phaseFourFixture } from './phase-four-fixture.js';

describe('Phase 4 reviewed and atomic recipe installation', () => {
  let f: Awaited<ReturnType<typeof phaseFourFixture>>,
    projectId: string,
    settings: SettingsDocument;
  beforeAll(async () => {
    f = await phaseFourFixture();
  });
  beforeEach(async () => {
    await f.db.orm.delete(projects).where(eq(projects.userId, f.userId));
    projectId = (await createProject(f.db, f.userId, { name: 'Recipe case' })).id;
    settings = freshSettings();
  });
  afterAll(async () => {
    await f?.close();
  });
  const input = (): RecipePreviewInput => ({
    projectId,
    recipeId: 22,
    requestId: randomUUID(),
    values: { question: 'What is the Orion launch date?' },
    schedule: { kind: 'manual' },
  });
  it('creates one bounded, tainted mission and outbox entry under simultaneous installation retries', async () => {
    const request = input();
    const preview = await previewRecipe(f.db, f.userId, request, settings);
    expect((await previewRecipe(f.db, f.userId, request, settings)).id).toBe(preview.id);
    expect(
      await f.db.orm.select().from(missions).where(eq(missions.projectId, projectId)),
    ).toHaveLength(0);
    const copies = await Promise.all([
      installRecipe(f.db, f.userId, preview.id, settings),
      installRecipe(f.db, f.userId, preview.id, settings),
    ]);
    expect(copies[0]?.missionId).toBe(copies[1]?.missionId);
    const detail = await getMission(f.db, f.userId, copies[0].missionId!);
    expect(detail?.mission).toMatchObject({
      recipePolicy: 'read_only',
      run: { tainted: true, limits: preview.limits },
    });
    expect(
      await f.db.orm
        .select()
        .from(queueOutbox)
        .where(eq(queueOutbox.runId, detail!.mission.run.id)),
    ).toHaveLength(1);
    expect(
      await f.db.orm
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'recipe.installed'), eq(auditLog.target, preview.id))),
    ).toHaveLength(1);
    expect(
      (await installRecipe(f.db, f.userId, preview.id, settings, new Date('2040-01-01'))).missionId,
    ).toBe(detail!.mission.id);
  });
  it('rejects changed, expired or other-owner reviews without creating work', async () => {
    const request = input(),
      now = new Date('2026-11-03T08:00:00Z');
    const preview = await previewRecipe(f.db, f.userId, request, settings, now);
    await expect(
      previewRecipe(
        f.db,
        f.userId,
        { ...request, values: { question: 'Changed question' } },
        settings,
        now,
      ),
    ).rejects.toMatchObject({ code: 'RECIPE_CONFLICT' });
    await expect(
      installRecipe(f.db, 'other-owner', preview.id, settings, now),
    ).rejects.toMatchObject({ code: 'RECIPE_NOT_FOUND' });
    expect(await listRecipeInstallations(f.db, 'other-owner')).toEqual([]);
    await expect(
      installRecipe(f.db, f.userId, preview.id, settings, new Date(now.getTime() + 16 * 60_000)),
    ).rejects.toMatchObject({ code: 'RECIPE_CONFLICT' });
    settings.budgets.value.perRunUsd += 1;
    await expect(installRecipe(f.db, f.userId, preview.id, settings, now)).rejects.toMatchObject({
      code: 'RECIPE_CONFLICT',
    });
    expect(
      await f.db.orm.select().from(missions).where(eq(missions.projectId, projectId)),
    ).toHaveLength(0);
  });
  it('rolls back mission creation when the installation receipt cannot commit, then safely retries', async () => {
    const preview = await previewRecipe(f.db, f.userId, input(), settings);
    // This is a fresh dedicated *_test database; the constraint injects a real transaction failure.
    await f.db.pool.query(
      'ALTER TABLE recipe_installations ADD CONSTRAINT phase4_recipe_failure CHECK (installed_at IS NULL)',
    );
    try {
      await expect(installRecipe(f.db, f.userId, preview.id, settings)).rejects.toThrow();
      expect(
        await f.db.orm.select().from(missions).where(eq(missions.projectId, projectId)),
      ).toHaveLength(0);
      expect((await listRecipeInstallations(f.db, f.userId))[0]?.installedAt).toBeNull();
    } finally {
      await f.db.pool.query(
        'ALTER TABLE recipe_installations DROP CONSTRAINT phase4_recipe_failure',
      );
    }
    expect((await installRecipe(f.db, f.userId, preview.id, settings)).missionId).toBeTruthy();
    expect(
      await f.db.orm.select().from(missions).where(eq(missions.projectId, projectId)),
    ).toHaveLength(1);
  });
  it('preserves reviewed schedules, policy limits and taint through manual and scheduled trigger execution', async () => {
    const preview = await previewRecipe(
      f.db,
      f.userId,
      {
        ...input(),
        recipeId: 9,
        values: { urls: 'https://example.test/status' },
        schedule: { kind: 'cron', expression: '*/30 * * * *', timezone: 'Asia/Kolkata' },
      },
      settings,
    );
    const installed = await installRecipe(f.db, f.userId, preview.id, settings);
    const [trigger] = await f.db.orm
      .select()
      .from(triggers)
      .where(eq(triggers.id, installed.triggerId!));
    expect(trigger?.config).toEqual(preview.schedule);
    const manualId = await triggerMission(f.db, f.userId, trigger!.id, () => settings);
    expect((await getMission(f.db, f.userId, manualId!))?.mission).toMatchObject({
      recipePolicy: 'read_only',
      run: { tainted: true },
    });
    const runner = createAutomationRunner({
      database: f.db,
      getSettings: () => settings,
      signal: new AbortController().signal,
      listImap: vi.fn(),
    });
    await runner.tick(trigger!.nextRunAt!);
    await runner.tick(trigger!.nextRunAt!);
    const created = await f.db.orm.select().from(missions).where(eq(missions.projectId, projectId));
    expect(created).toHaveLength(2);
    expect(created.every((value) => value.recipePolicy === 'read_only')).toBe(true);
  });
  it('checks IMAP read scope again at installation and prevents stale connector authorization', async () => {
    const request: RecipePreviewInput = {
      ...input(),
      recipeId: 2,
      values: {},
      schedule: {
        kind: 'imap',
        connectorId: fixtureMailAccount.id,
        mailbox: 'INBOX',
        pollIntervalSeconds: 300,
      },
    };
    await expect(previewRecipe(f.db, f.userId, request, settings)).rejects.toMatchObject({
      code: 'RECIPE_CONNECTOR',
    });
    settings.connectors.value.accounts = [fixtureMailAccount];
    const preview = await previewRecipe(f.db, f.userId, request, settings);
    settings.connectors.value.accounts = [];
    await expect(installRecipe(f.db, f.userId, preview.id, settings)).rejects.toMatchObject({
      code: 'RECIPE_CONNECTOR',
    });
    settings.connectors.value.accounts = [fixtureMailAccount];
    const installed = await installRecipe(f.db, f.userId, preview.id, settings);
    expect(installed.triggerId).toBeTruthy();
  });
  it('enforces read-only and send-approval restrictions in the real durable executor', async () => {
    const execute = vi.fn().mockResolvedValue({ sent: true });
    for (const recipeId of [22, 2] as const) {
      const preview = await previewRecipe(
        f.db,
        f.userId,
        { ...input(), recipeId, values: recipeId === 22 ? { question: 'Find the date.' } : {} },
        settings,
      );
      const installed = await installRecipe(f.db, f.userId, preview.id, settings);
      const detail = (await getMission(f.db, f.userId, installed.missionId!))!;
      const name = recipeId === 22 ? 'files.fixture_write' : 'email.fixture_send';
      const tools = new ToolRegistry([
        defineTool({
          name,
          description: 'Recipe fixture action',
          effect: recipeId === 22 ? 'write' : 'send',
          scope: recipeId === 22 ? 'internal' : 'external',
          input: z.strictObject({}),
          output: z.strictObject({ sent: z.boolean() }),
          run: execute,
        }),
      ]);
      const runner = createDurableExecutor({
        database: f.db,
        workerId: workKey('wrk'),
        dataDir: f.directory,
        getSettings: () => settings,
        tools,
        router: () => createFixtureRouter({ toolName: name }),
      });
      await runner.execute(detail.mission.run.id);
      const result = (await getMission(f.db, f.userId, installed.missionId!))!;
      expect(result.mission.run.status).toBe(recipeId === 22 ? 'completed' : 'waiting_approval');
      if (recipeId === 2) expect(result.approvals).toHaveLength(1);
    }
    expect(execute).not.toHaveBeenCalled();
  });
  it('authenticates all recipe APIs, rejects unrecognized input and masks stored text that becomes a secret', async () => {
    expect((await f.request('GET', '/api/recipes', undefined, false)).statusCode).toBe(401);
    const catalogue = await f.request('GET', '/api/recipes');
    expect(z.array(recipeTemplateSchema).parse(catalogue.json())).toHaveLength(24);
    const request = input();
    expect(
      (await f.request('POST', '/api/recipes/preview', request, true, 'https://attacker.test'))
        .statusCode,
    ).toBe(403);
    expect(
      (await f.request('POST', '/api/recipes/preview', { ...request, policy: 'allow' })).statusCode,
    ).toBe(400);
    const canary = 'recipe-secret-canary-18293746';
    const response = await f.request('POST', '/api/recipes/preview', {
      ...request,
      values: { question: canary },
    });
    expect(response.statusCode).toBe(200);
    const preview = recipeInstallationSchema.parse(response.json());
    secretRedactor.register(canary);
    const listed = await f.request('GET', '/api/recipes/installations');
    expect(listed.body).not.toContain(canary);
    const rejected = await f.request('POST', `/api/recipes/${preview.id}/install`, {});
    expect(rejected.statusCode).toBe(409);
    expect(rejected.body).not.toContain(canary);
    expect(
      (
        await f.request('POST', '/api/recipes/preview', {
          ...input(),
          values: { question: canary },
        })
      ).statusCode,
    ).toBe(400);
    const safe = await f.request('POST', '/api/recipes/preview', input());
    const id = recipeInstallationSchema.parse(safe.json()).id;
    expect((await f.request('POST', `/api/recipes/${id}/install`, {})).statusCode).toBe(200);
    expect(f.logLines.join('')).not.toContain(canary);
    expect(
      await f.db.orm
        .select()
        .from(recipeInstallations)
        .where(eq(recipeInstallations.userId, f.userId)),
    ).toHaveLength(2);
  });
});
