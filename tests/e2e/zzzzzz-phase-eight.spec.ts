import { expect, test, type BrowserContext, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { settingsDocumentSchema } from '@sazuz/config/settings';
import {
  workflowSchema,
  workflowRunSchema,
  workflowNodeSchema,
  workflowDraftSchema,
  type WorkflowRun,
} from '@sazuz/core/workflows';
import { missionDetailSchema, notificationSchema } from '@sazuz/core/missions';
import { projectSchema } from '@sazuz/core/work';
import { recipeInstallationSchema } from '@sazuz/core/recipes';
import { knowledgeJobSchema } from '@sazuz/core/memory';
import { phaseEightGraph, phaseEightModelKey, startPhaseEightModel } from './phase-eight-model';

async function prepare(context: BrowserContext, info: TestInfo, name: string) {
  const origin = z.string().parse(info.project.use.baseURL);
  const api = async <T>(method: string, path: string, schema: z.ZodType<T>, data?: unknown) => {
    const response = await context.request.fetch('/api/' + path, {
      method,
      headers: { origin },
      ...(data === undefined ? {} : { data }),
    });
    expect(response.status(), method + ' ' + path).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(phaseEightModelKey);
    return schema.parse(JSON.parse(text));
  };
  await api('POST', 'auth/sign-in/email', z.unknown(), {
    email: 'browser-owner@example.test',
    password: 'Browser-admin-password-7814',
  });
  const model = await startPhaseEightModel();
  try {
    const secret = await api('POST', 'vault/secrets', z.object({ reference: z.string() }), {
      name: 'Phase 8 model fixture',
      value: phaseEightModelKey,
    });
    let settings = await api('GET', 'settings', settingsDocumentSchema);
    await api('PUT', 'settings/providers', z.unknown(), {
      expectedVersion: settings.providers.version,
      value: {
        items: [
          {
            id: 'phase8-fixture',
            name: 'Phase 8 local model',
            kind: 'openai-compatible',
            baseUrl: model.baseUrl,
            secretRef: secret.reference,
            locality: 'local',
            enabled: true,
          },
        ],
      },
    });
    await api('POST', 'providers/phase8-fixture/discover', z.unknown(), {});
    settings = await api('GET', 'settings', settingsDocumentSchema);
    const assignment = { providerId: 'phase8-fixture', modelId: 'gpt-4o' };
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
        modelLimits: [{ ...assignment, contextWindow: 131072, maxOutput: 8192 }],
        priceOverrides: [{ ...assignment, price: { inputPerMTok: 1, outputPerMTok: 2 } }],
        providerRateLimits: [{ providerId: 'phase8-fixture', requestsPerMinute: 600, burst: 50 }],
      },
    });
    await api('PUT', 'settings/profile', z.unknown(), {
      expectedVersion: settings.profile.version,
      value: {
        ...settings.profile.value,
        quietStart: '00:00',
        quietEnd: '00:00',
        noiseBudget: 3,
        digestTimes: [],
        priorityModel: true,
      },
    });
    await api('PUT', 'settings/channels', z.unknown(), {
      expectedVersion: settings.channels.version,
      value: { ...settings.channels.value, urgent: 'web', digest: 'web' },
    });
    await api('PUT', 'settings/budgets', z.unknown(), {
      expectedVersion: settings.budgets.version,
      value: { ...settings.budgets.value, maxSteps: 100, perRunUsd: 2, maxWallTimeSeconds: 180 },
    });
    const project = await api('POST', 'projects', projectSchema, {
      name,
      privacy: 'private',
      budgetUsd: 10,
    });
    const completed = async (id: string) => {
      let run: WorkflowRun | undefined;
      await expect
        .poll(
          async () => {
            run = await api('GET', 'workflows/runs/' + id, workflowRunSchema);
            return run.status;
          },
          { timeout: 60000, intervals: [500, 1000] },
        )
        .toBe('completed');
      return run!;
    };
    const notificationFor = async (run: WorkflowRun) => {
      let notification: z.infer<typeof notificationSchema> | undefined;
      await expect
        .poll(
          async () => {
            notification = (await api('GET', 'notifications', z.array(notificationSchema))).find(
              (item) => item.missionId === run.missionId && item.title.endsWith(': completed'),
            );
            return notification?.priorityEvidence?.model;
          },
          { timeout: 20000, intervals: [500, 1000] },
        )
        .toBe(run.modelFree ? 'rules' : 'classified');
      return notification!;
    };
    return { api, model, project, completed, notificationFor };
  } catch (error) {
    await model.close();
    throw error;
  }
}

test('Phase 8 production: deterministic execution uses no model; an edited NL draft runs on its reviewed schedule', async ({
  page,
  context,
}, info) => {
  test.setTimeout(240000);
  test.skip(!process.env.PLAYWRIGHT_SETUP_DATA_DIR, 'Requires the fresh production setup stack.');
  const { api, model, project, completed, notificationFor } = await prepare(
    context,
    info,
    'Phase 8 workflow acceptance',
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let scheduledId: string | undefined;
  try {
    await page.goto('/workflows');
    await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(project.id);
    await page.getByRole('button', { name: 'Create workflow', exact: true }).click();
    await expect(page).toHaveURL(/\/workflows\/wf_/);
    const deterministicId = page.url().split('/').at(-1)!;
    await page.getByText('Edit workflow JSON', { exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Workflow definition', exact: true })
      .fill(JSON.stringify(phaseEightGraph('Phase8 deterministic')));
    await page.getByRole('button', { name: 'Apply workflow JSON', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Run reviewed revision' })).toBeDisabled();
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Phase8 deterministic', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Review revision', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Run reviewed revision' })).toBeEnabled();
    const started = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/workflows/' + deterministicId + '/runs') &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Run reviewed revision' }).click();
    const first = workflowRunSchema.parse(await (await started).json());
    const pure = await completed(first.id);
    await notificationFor(pure);
    expect(pure).toMatchObject({
      modelFree: true,
      output: { result: { zone: 'UTC', marker: 'Phase8 deterministic output' } },
    });
    expect(model.requests).toHaveLength(0);
    await expect(page.getByText('No model calls', { exact: false })).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: 'Node type', exact: false }).locator('option'),
    ).toHaveCount(12);
    await page.getByText('result · completed · attempt 1', { exact: true }).click();
    await expect(
      page
        .locator('.workflow-history details')
        .filter({ has: page.getByText('result · completed · attempt 1', { exact: true }) })
        .locator('pre'),
    ).toContainText('Phase8 deterministic output');

    await page.goto('/workflows');
    await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(project.id);
    await page.getByRole('button', { name: 'Create workflow', exact: true }).click();
    await expect(page).toHaveURL(/\/workflows\/wf_/);
    scheduledId = page.url().split('/').at(-1)!;
    await page
      .getByRole('textbox', { name: 'Workflow request', exact: false })
      .fill(
        'Every minute read the current time, ask Writer for a source-backed summary and collect the result.',
      );
    await page.getByRole('checkbox', { name: 'Use private models only', exact: false }).check();
    await page.getByRole('button', { name: 'Generate draft', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Apply to editor', exact: true })).toBeVisible({
      timeout: 45000,
    });
    const receipts = await api(
      'GET',
      'workflows/drafts?projectId=' + project.id,
      z.array(workflowDraftSchema),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: 'ready', privateOnly: true });
    expect(receipts[0]!.costUsd).toBeGreaterThan(0);
    const pending = await api('GET', 'workflows/' + scheduledId, workflowSchema);
    expect(pending).toMatchObject({ activeRevision: null, enabled: false });
    expect(
      await api('GET', 'workflows/' + scheduledId + '/runs', z.array(workflowRunSchema)),
    ).toEqual([]);
    await page.getByRole('button', { name: 'Retrieve this request', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Retrieve this request', exact: true }),
    ).toBeEnabled();
    expect(model.requests).toHaveLength(1);
    await page.getByRole('button', { name: 'Apply to editor', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Workflow name', exact: true })
      .fill('Phase8 reviewed schedule');
    await page.getByRole('combobox', { name: 'Select node', exact: true }).selectOption('result');
    await page.getByRole('textbox', { name: 'Node label', exact: true }).fill('Reviewed report');
    await page.getByRole('button', { name: 'Apply node changes', exact: true }).click();
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Phase8 reviewed schedule', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run reviewed revision' })).toBeDisabled();
    await page.getByRole('button', { name: 'Review and enable trigger', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Disable trigger', exact: true })).toBeVisible();
    let scheduled: WorkflowRun[] = [];
    await expect
      .poll(
        async () => {
          scheduled = await api(
            'GET',
            'workflows/' + scheduledId + '/runs',
            z.array(workflowRunSchema),
          );
          return scheduled.length;
        },
        { timeout: 80000, intervals: [500, 1000] },
      )
      .toBe(1);
    await page.getByRole('button', { name: 'Disable trigger', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Review and enable trigger', exact: true }),
    ).toBeVisible();
    const mixed = await completed(scheduled[0]!.id);
    await notificationFor(mixed);
    expect(mixed.modelFree).toBe(false);
    expect(mixed.nodes.find((node) => node.key === 'clock')?.output).toMatchObject({
      timeZone: 'UTC',
    });
    expect(mixed.output).toMatchObject({ result: { summary: 'Phase8 verified source summary' } });
    expect(
      (await api('GET', 'workflows/' + scheduledId, workflowSchema)).definition.nodes.find(
        (node) => node.id === 'result',
      )?.label,
    ).toBe('Reviewed report');
    expect(model.categories).toEqual(['draft', 'agent', 'priority']);
    const jobs = await api('GET', 'memory/jobs', z.array(knowledgeJobSchema));
    expect(
      jobs.filter(
        (job) =>
          job.runId !== null &&
          [
            pure.id,
            mixed.id,
            ...pure.nodes.map((node) => node.runId),
            ...mixed.nodes.map((node) => node.runId),
          ].includes(job.runId),
      ),
    ).toEqual([]);
    await expect(page.getByText('Includes agent steps', { exact: false })).toBeVisible();
    await page.screenshot({ path: info.outputPath('phase8-workflow-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: info.outputPath('phase8-workflow-mobile.png'), fullPage: true });
    expect(errors).toEqual([]);
    expect(model.failures).toEqual([]);
    expect(JSON.stringify(model.requests)).not.toContain(phaseEightModelKey);
    await info.attach('phase8-workflow-production-evidence', {
      contentType: 'application/json',
      body: JSON.stringify({
        deterministicRunId: pure.id,
        deterministicMissionId: pure.missionId,
        deterministicModelCalls: 0,
        generatedDraftId: receipts[0]!.id,
        editedWorkflowId: scheduledId,
        scheduledRunId: mixed.id,
        scheduledMissionId: mixed.missionId,
        modelRequests: model.requests.length,
        modelCategories: model.categories,
        noCompletionExtraction: true,
        keyboardReview: true,
        mobileNoOverflow: true,
        errors,
      }),
    });
  } finally {
    if (scheduledId) {
      const saved = await api('GET', 'workflows/' + scheduledId, workflowSchema);
      if (saved.enabled)
        await api('POST', 'workflows/' + scheduledId + '/review', workflowSchema, {
          expectedVersion: saved.version,
          revision: saved.activeRevision,
          enabled: false,
        });
    }
    await model.close();
    await info.attach('phase8-workflow-model-diagnostics', {
      contentType: 'application/json',
      body: JSON.stringify({ requests: model.requests.length, failures: model.failures }),
    });
  }
});

test('Phase 8 production: recipe installation runs a reviewed graph and Calm feedback persists through Settings', async ({
  page,
  context,
}, info) => {
  test.setTimeout(180000);
  test.skip(!process.env.PLAYWRIGHT_SETUP_DATA_DIR, 'Requires the fresh production setup stack.');
  const { api, model, project, completed, notificationFor } = await prepare(
    context,
    info,
    'Phase 8 recipe and Calm acceptance',
  );
  const notificationTitle = `Phase8 searchable low-priority item (${project.id})`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('/recipes');
    await expect(
      page.getByRole('region', { name: 'Recipe catalogue' }).getByRole('button'),
    ).toHaveCount(24);
    await page
      .getByRole('searchbox', { name: 'Find a recipe', exact: false })
      .fill('Weekly Review');
    await page.getByRole('button', { name: 'Weekly Review', exact: true }).click();
    await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(project.id);
    await page
      .getByRole('textbox', { name: 'Sources, evidence and owner instructions', exact: false })
      .fill('Review this project and report missing activity honestly.');
    await page.getByRole('combobox', { name: 'Run when', exact: true }).selectOption('manual');
    await page.getByRole('button', { name: 'Preview recipe', exact: true }).click();
    const preview = page.getByRole('region', { name: 'Recipe preview', exact: true });
    await expect(preview.getByRole('region', { name: 'Workflow graph preview' })).toContainText(
      'project.activity',
    );
    const installedResponse = page.waitForResponse(
      (response) =>
        /\/api\/recipes\/rcp_[^/]+\/install$/.test(response.url()) &&
        response.request().method() === 'POST',
    );
    await preview.getByRole('button', { name: 'Install and run', exact: true }).click();
    const installation = recipeInstallationSchema.parse(await (await installedResponse).json());
    await expect(preview.getByRole('link', { name: 'Edit workflow', exact: true })).toBeVisible();
    const recipeRuns = await api(
      'GET',
      'workflows/' + installation.workflowId + '/runs',
      z.array(workflowRunSchema),
    );
    const recipeRun = await completed(recipeRuns[0]!.id);
    await notificationFor(recipeRun);
    expect(recipeRun.nodes.find((node) => node.key === 'activity')?.output).toMatchObject({
      runs: [],
      costUsd: 0,
    });
    expect(
      (await api('POST', 'recipes/' + installation.id + '/install', recipeInstallationSchema, {}))
        .workflowId,
    ).toBe(installation.workflowId);

    const definition = phaseEightGraph('Phase8 Calm source');
    definition.nodes = [
      definition.nodes[0]!,
      workflowNodeSchema.parse({
        id: 'notify',
        label: 'Calm fixture notification',
        position: { x: 280, y: 0 },
        input: JSON.stringify({
          level: 'low',
          title: notificationTitle,
          body: 'Keep this owner-reviewed update in activity.',
        }),
        action: { kind: 'notify' },
      }),
    ];
    definition.edges = [{ from: 'start', to: 'notify' }];
    let notify = await api('POST', 'workflows', workflowSchema, {
      projectId: project.id,
      expectedVersion: 0,
      definition,
    });
    notify = await api('POST', 'workflows/' + notify.id + '/review', workflowSchema, {
      expectedVersion: notify.version,
      revision: notify.revision,
      enabled: false,
    });
    const baseline = model.requests.length;
    const started = await api('POST', 'workflows/' + notify.id + '/runs', workflowRunSchema, {
      requestId: randomUUID(),
      revision: notify.activeRevision,
      input: {},
    });
    let detail: z.infer<typeof missionDetailSchema> | undefined;
    await expect
      .poll(
        async () => {
          detail = await api('GET', 'missions/' + started.missionId, missionDetailSchema);
          return detail.approvals.some((approval) => approval.status === 'pending');
        },
        { timeout: 45000, intervals: [500, 1000] },
      )
      .toBe(true);
    const approval = detail!.approvals.find((item) => item.status === 'pending')!;
    expect(approval.toolName).toBe('workflow.notify');
    expect(
      (
        await api(
          'GET',
          'notifications?q=' + encodeURIComponent(notificationTitle),
          z.array(notificationSchema),
        )
      ).filter((item) => item.missionId === started.missionId && item.title === notificationTitle),
    ).toEqual([]);
    await api('POST', 'approvals/' + approval.id + '/decision', z.unknown(), {
      version: approval.version,
      action: 'approve',
    });
    const notified = await completed(started.id);
    await notificationFor(notified);
    await page.goto('/automations');
    await page
      .getByRole('searchbox', { name: 'Search notifications', exact: true })
      .fill(notificationTitle);
    await page
      .getByRole('region', { name: 'Notifications and digests', exact: true })
      .getByRole('button', { name: 'Search', exact: true })
      .click();
    const card = page.getByRole('article', {
      name: notificationTitle,
      exact: true,
    });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Not important', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Not important', exact: true })).toBeDisabled();
    await expect(card.getByRole('status')).toContainText('Preference saved');
    await page.reload();
    await page
      .getByRole('combobox', { name: 'Activity view', exact: true })
      .selectOption('notifications');
    await card.getByRole('button', { name: 'Should have told me sooner', exact: true }).click();
    await expect(
      card.getByRole('button', { name: 'Should have told me sooner', exact: true }),
    ).toBeDisabled();
    await expect(card.getByRole('button', { name: 'Not important', exact: true })).toBeEnabled();
    await expect(card.getByRole('status')).toContainText('Preference saved');
    const saved = await api('GET', 'settings', settingsDocumentSchema);
    const rule = saved.profile.value.priorityRules.find((item) => item.projectId === project.id);
    expect(rule?.bias).toBeGreaterThan(0);
    expect(model.requests.length).toBe(baseline);
    await page.goto('/settings?section=profile');
    await expect(page.getByRole('spinbutton', { name: 'Noise Budget', exact: true })).toHaveValue(
      '3',
    );
    await expect(
      page.getByRole('checkbox', { name: 'Fast-model priority classification', exact: true }),
    ).toBeChecked();
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({
      path: info.outputPath('phase8-calm-settings-mobile.png'),
      fullPage: true,
    });
    expect(errors).toEqual([]);
    expect(model.failures).toEqual([]);
    expect(JSON.stringify(model.requests)).not.toContain(phaseEightModelKey);
    await info.attach('phase8-calm-recipe-production-evidence', {
      contentType: 'application/json',
      body: JSON.stringify({
        recipes: 24,
        installedWorkflowId: installation.workflowId,
        recipeRunId: recipeRun.id,
        recipeMissionId: recipeRun.missionId,
        notifyRunId: notified.id,
        notifyMissionId: notified.missionId,
        approvalId: approval.id,
        feedbackBias: rule?.bias,
        noiseBudget: saved.profile.value.noiseBudget,
        modelRequests: model.requests.length,
        modelCategories: model.categories,
        deterministicNotificationModelCalls: model.requests.length - baseline,
        errors,
      }),
    });
  } finally {
    await model.close();
    await info.attach('phase8-calm-model-diagnostics', {
      contentType: 'application/json',
      body: JSON.stringify({ requests: model.requests.length, failures: model.failures }),
    });
  }
});
