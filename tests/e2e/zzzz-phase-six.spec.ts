import { expect, test } from '@playwright/test';
import { z } from 'zod';
import { settingsDocumentSchema } from '@sazuz/config/settings';
import { agentRevisionSchema } from '@sazuz/core/agents';
import { missionDetailSchema, missionSchema } from '@sazuz/core/missions';
import { projectSchema } from '@sazuz/core/work';
import { phaseSixModelKey, phaseSixReasoning, startPhaseSixModel } from './phase-six-model';
import { waitForProductionExtractions } from './production-jobs';

test('Phase 6 production: form/YAML/history, five-task graph, automatic Auditor repair and mobile keyboard access', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(180000);
  test.skip(
    !process.env.PLAYWRIGHT_SETUP_DATA_DIR,
    'Requires the fresh production stack used by the setup suite.',
  );
  const origin = z.string().parse(testInfo.project.use.baseURL);
  const model = await startPhaseSixModel();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const api = async <T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown) => {
    const response = await context.request.fetch(`/api/${path}`, {
      method,
      headers: { origin },
      ...(body === undefined ? {} : { data: body }),
    });
    expect(response.status(), `${method} ${path}`).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(phaseSixModelKey);
    return schema.parse(JSON.parse(text));
  };
  try {
    await api('POST', 'auth/sign-in/email', z.unknown(), {
      email: 'browser-owner@example.test',
      password: 'Browser-admin-password-7814',
    });
    const original = await api('GET', 'agents/writer', agentRevisionSchema);
    await page.goto('/agents/writer');
    await expect(
      page.getByRole('navigation', { name: 'Agent team' }).getByRole('link'),
    ).toHaveCount(10);
    await page
      .getByRole('textbox', { name: 'Instructions', exact: true })
      .fill(original.definition.instructions + '\nUse numbered sections.');
    await page.getByRole('button', { name: 'Save revision', exact: true }).click();
    await expect(page.getByText(`Revision ${original.version + 1}`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'YAML', exact: true }).click();
    await page.getByRole('textbox', { name: /^Agent YAML/ }).fill('id: &a [*a]');
    await page.getByRole('button', { name: 'Save revision', exact: true }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'Check the agent definition',
    );
    const changed = await api('GET', 'agents/writer', agentRevisionSchema);
    await page
      .getByRole('textbox', { name: /^Agent YAML/ })
      .fill(
        JSON.stringify(
          { ...changed.definition, description: 'Phase 6 reviewed writing definition.' },
          null,
          2,
        ),
      );
    await page.getByRole('button', { name: 'Save revision', exact: true }).click();
    await expect(page.getByText(`Revision ${original.version + 2}`, { exact: true })).toBeVisible();
    await page.getByText('Version history', { exact: true }).click();
    await page
      .getByRole('button', { name: `Restore version ${original.version}`, exact: true })
      .click();
    await expect(page.getByText(`Revision ${original.version + 3}`, { exact: true })).toBeVisible();
    expect((await api('GET', 'agents/writer', agentRevisionSchema)).definition.instructions).toBe(
      original.definition.instructions,
    );
    const credential = await api('POST', 'vault/secrets', z.object({ reference: z.string() }), {
      name: 'Phase 6 model fixture',
      value: phaseSixModelKey,
    });
    let settings = await api('GET', 'settings', settingsDocumentSchema);
    await api('PUT', 'settings/providers', z.unknown(), {
      expectedVersion: settings.providers.version,
      value: {
        items: [
          {
            id: 'phase6-fixture',
            name: 'Phase 6 local model',
            kind: 'openai-compatible',
            baseUrl: model.baseUrl,
            secretRef: credential.reference,
            locality: 'local',
            enabled: true,
          },
        ],
      },
    });
    await api('POST', 'providers/phase6-fixture/discover', z.unknown(), {});
    settings = await api('GET', 'settings', settingsDocumentSchema);
    const assignment = { providerId: 'phase6-fixture', modelId: 'gpt-4o' };
    await api('PUT', 'settings/models', z.unknown(), {
      expectedVersion: settings.models.version,
      value: {
        ...settings.models.value,
        roles: {
          planner: assignment,
          executor: assignment,
          fast: assignment,
          vision: assignment,
          embedding: null,
        },
        modelLimits: [{ ...assignment, contextWindow: 131072, maxOutput: 4096 }],
        providerRateLimits: [{ providerId: 'phase6-fixture', requestsPerMinute: 600, burst: 50 }],
      },
    });
    const project = await api('POST', 'projects', projectSchema, {
      name: 'Phase 6 reviewed mission',
      privacy: 'private',
      budgetUsd: 10,
    });
    await page.goto('/missions');
    await page.getByRole('button', { name: 'New mission', exact: true }).click();
    const composer = page.getByRole('region', { name: 'New mission', exact: true });
    await composer.getByRole('combobox', { name: 'Project', exact: true }).selectOption(project.id);
    await composer
      .getByRole('combobox', { name: 'Auditor review mode', exact: true })
      .selectOption('all');
    await composer.getByRole('button', { name: 'Save review mode', exact: true }).click();
    await expect(composer.getByText(/Project review updated/)).toBeVisible();
    await composer
      .getByRole('textbox', { name: 'Mission title (optional)', exact: true })
      .fill('Phase 6 acceptance report');
    await composer
      .getByRole('textbox', { name: 'Mission goal', exact: true })
      .fill(
        'Complete five tasks in two independent branches. Include Summary and Risks in each result, repair missing criteria, and merge the report.',
      );
    const response = page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === '/api/missions' && value.request().method() === 'POST',
    );
    await composer.getByRole('button', { name: 'Start mission', exact: true }).click();
    const mission = missionSchema.parse(await (await response).json());
    let detail: z.infer<typeof missionDetailSchema> | undefined;
    await expect
      .poll(
        async () => {
          detail = await api('GET', `missions/${mission.id}`, missionDetailSchema);
          return ['completed', 'failed', 'cancelled', 'budget_exceeded', 'paused'].includes(
            detail.mission.run.status,
          );
        },
        { timeout: 90000, intervals: [500, 1000] },
      )
      .toBe(true);
    expect(
      detail!.mission.run.status,
      JSON.stringify({ reason: detail!.mission.run.reason, fixtureFailures: model.failures }),
    ).toBe('completed');
    expect(detail!.graph?.tasks).toHaveLength(5);
    expect(detail!.graph?.revision).toBe(2);
    expect(detail!.graph?.tasks.find((task) => task.key === 'draft')?.attempt).toBe(2);
    expect(detail!.reviews.filter((review) => review.status === 'rejected')).toHaveLength(1);
    expect(detail!.reviews.at(-1)?.status).toBe('accepted');
    await waitForProductionExtractions(context.request, [detail!.mission.run.id]);
    await page.goto(`/missions/${mission.id}`);
    const graph = page.getByRole('region', { name: 'Mission graph and tasks', exact: true });
    await expect(graph.getByRole('region', { name: 'Mission task graph' })).toBeVisible();
    const list = graph.getByRole('list', { name: 'Task list' });
    await expect(list.getByRole('button')).toHaveCount(5);
    const draft = list.getByRole('button', { name: /^draft/ });
    await draft.focus();
    await page.keyboard.press('Enter');
    await expect(graph.getByRole('article', { name: 'Task draft details' })).toContainText(
      'Attempt 2 of 3',
    );
    const reviews = page.getByRole('region', { name: 'Auditor reviews', exact: true });
    await reviews
      .locator('summary')
      .filter({ hasText: /^Auditor rejected/ })
      .click();
    await expect(reviews).toContainText('c2: Needs correction');
    await expect(page.getByRole('region', { name: 'Team activity' })).toContainText(
      'Repair the omitted Risks section',
    );
    await expect(
      page.getByText('Sources reviewed; preserve uncertainty in Risks.', { exact: true }).first(),
    ).toBeVisible();
    await graph.screenshot({ path: testInfo.outputPath('phase6-task-graph.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await draft.focus();
    await page.keyboard.press('Enter');
    await expect(graph.getByRole('article', { name: 'Task draft details' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await graph.screenshot({ path: testInfo.outputPath('phase6-mobile-graph.png') });
    const reviewRequests = model.requests.filter((request) =>
      String(request.messages[0]?.content).includes('independent Auditor'),
    );
    expect(reviewRequests.length).toBeGreaterThanOrEqual(7);
    expect(JSON.stringify(reviewRequests)).not.toContain(phaseSixReasoning);
    expect(JSON.stringify(model.requests)).not.toContain(phaseSixModelKey);
    expect(model.failures).toEqual([]);
    expect(errors).toEqual([]);
    await testInfo.attach('phase6-production-evidence', {
      body: JSON.stringify(
        {
          missionId: mission.id,
          tasks: 5,
          graphRevision: detail!.graph!.revision,
          reviews: detail!.reviews.map((review) => ({ status: review.status, kind: review.kind })),
          modelRequests: model.requests.length,
          credentialsAbsent: true,
          independentReviewer: true,
          mobileKeyboard: true,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  } finally {
    await testInfo.attach('phase6-model-diagnostics', {
      body: JSON.stringify({ requests: model.requests.length, failures: model.failures }),
      contentType: 'application/json',
    });
    await model.close();
  }
});
