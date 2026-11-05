import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type TestInfo } from '@playwright/test';
import { z } from 'zod';
import { settingsDocumentSchema } from '@sazuz/config/settings';
import { evalReportSchema, evalRunSchema } from '@sazuz/core/evals';
import { costDashboardSchema, telemetryStatusSchema } from '@sazuz/core/observability';
import { missionDetailSchema, missionSchema } from '@sazuz/core/missions';
import { runDetailSchema } from '@sazuz/core/replay';
import { projectSchema } from '@sazuz/core/work';
import { knowledgeJobSchema } from '@sazuz/core/memory';
import { phaseTenModelKey, phaseTenCollectorKey, startPhaseTenModel } from './phase-ten-model';
import { waitForProductionExtractions } from './production-jobs';

async function prepare(context: BrowserContext, info: TestInfo, name: string) {
  const origin = z.string().parse(info.project.use.baseURL);
  const model = await startPhaseTenModel();
  const api = async <T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown) => {
    const response = await context.request.fetch(`/api/${path}`, {
      method,
      headers: { origin },
      ...(body === undefined ? {} : { data: body }),
    });
    expect(response.status(), `${method} ${path}`).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(phaseTenModelKey);
    expect(text).not.toContain(phaseTenCollectorKey);
    return schema.parse(JSON.parse(text));
  };
  try {
    await api('POST', 'auth/sign-in/email', z.unknown(), {
      email: 'browser-owner@example.test',
      password: 'Browser-admin-password-7814',
    });
    const credential = await api('POST', 'vault/secrets', z.object({ reference: z.string() }), {
      name: 'Phase 10 protocol model',
      value: phaseTenModelKey,
    });
    let settings = await api('GET', 'settings', settingsDocumentSchema);
    await api('PUT', 'settings/providers', z.unknown(), {
      expectedVersion: settings.providers.version,
      value: {
        items: [
          {
            id: 'phase10-fixture',
            name: 'Phase 10 protocol fixture',
            kind: 'openai-compatible',
            baseUrl: model.baseUrl,
            secretRef: credential.reference,
            locality: 'local',
            enabled: true,
          },
        ],
      },
    });
    await api('POST', 'providers/phase10-fixture/discover', z.unknown(), {});
    settings = await api('GET', 'settings', settingsDocumentSchema);
    const assignment = { providerId: 'phase10-fixture', modelId: 'gpt-4o' };
    const alternatives = [assignment, { providerId: 'phase10-fixture', modelId: 'gpt-4o-mini' }];
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
        modelLimits: alternatives.map((item) => ({
          ...item,
          contextWindow: 131072,
          maxOutput: 8192,
        })),
        priceOverrides: alternatives.map((item) => ({
          ...item,
          price: { inputPerMTok: item.modelId === 'gpt-4o' ? 0.1 : 0.02, outputPerMTok: 0.2 },
        })),
        providerRateLimits: [
          { providerId: assignment.providerId, requestsPerMinute: 600, burst: 100 },
        ],
      },
    });
    await api('PUT', 'settings/profile', z.unknown(), {
      expectedVersion: settings.profile.version,
      value: {
        ...settings.profile.value,
        quietStart: '00:00',
        quietEnd: '00:00',
        digestTimes: [],
        priorityModel: false,
      },
    });
    await api('PUT', 'settings/channels', z.unknown(), {
      expectedVersion: settings.channels.version,
      value: { ...settings.channels.value, urgent: 'web', digest: 'web' },
    });
    await api('PUT', 'settings/security', z.unknown(), {
      expectedVersion: settings.security.version,
      value: { ...settings.security.value, preset: 'balanced', rules: [] },
    });
    await api('PUT', 'settings/budgets', z.unknown(), {
      expectedVersion: settings.budgets.version,
      value: {
        ...settings.budgets.value,
        maxSteps: 100,
        perRunUsd: 2,
        maxWallTimeSeconds: 600,
        dailyUsd: 100,
        monthlyUsd: 1000,
      },
    });
    const project = await api('POST', 'projects', projectSchema, {
      name,
      privacy: 'private',
      budgetUsd: 10,
    });
    const complete = async (id: string) => {
      let detail: z.infer<typeof missionDetailSchema> | undefined;
      await expect
        .poll(
          async () => {
            detail = await api('GET', `missions/${id}`, missionDetailSchema);
            const pending = detail.approvals.find((item) => item.status === 'pending');
            if (pending)
              await api('POST', `approvals/${pending.id}/decision`, z.unknown(), {
                action: 'approve',
                version: pending.version,
                note: 'Review this fixture action.',
              });
            return detail.mission.run.status;
          },
          { timeout: 60000, intervals: [250, 500, 1000] },
        )
        .toBe('completed');
      return detail!;
    };
    const evalComplete = async (id: string) => {
      let report: z.infer<typeof evalReportSchema> | undefined;
      await expect
        .poll(
          async () => {
            report = await api('GET', `evals/${id}`, evalReportSchema);
            return report.status;
          },
          { timeout: 150000, intervals: [250, 500, 1000] },
        )
        .toBe('completed');
      return report!;
    };
    return { api, model, project, complete, evalComplete };
  } catch (error) {
    await model.close();
    throw error;
  }
}

test('Phase 10 production: fork at a recorded tool step with another model and inspect the comparison', async ({
  page,
  context,
}, info) => {
  test.setTimeout(180000);
  const { api, model, project, complete } = await prepare(
    context,
    info,
    'Phase 10 replay comparison',
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const source = await api('POST', 'missions', missionSchema, {
      projectId: project.id,
      agent: 'coder',
      requestId: randomUUID(),
      goal: 'Phase10 replay source. Write the fixture note, then provide its comparable summary.',
    });
    await complete(source.id);
    await waitForProductionExtractions(context.request, [source.run.id]);
    const before = await api('GET', `runs/${source.run.id}/detail`, runDetailSchema);
    const step = before.steps.find((item) => item.toolName === 'files.write');
    expect(step).toBeDefined();
    await page.goto(`/runs/${source.run.id}`);
    await expect(page.getByRole('heading', { name: 'Run replay', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Starting step', exact: true }).selectOption(step!.id);
    await page
      .getByRole('combobox', { name: 'Model', exact: true })
      .selectOption(JSON.stringify({ providerId: 'phase10-fixture', modelId: 'gpt-4o-mini' }));
    await page
      .getByRole('textbox', { name: 'Additional instruction', exact: true })
      .fill('Keep the same factual summary for this comparison.');
    await page.getByRole('button', { name: 'Create simulated fork', exact: true }).click();
    await expect(page).not.toHaveURL(new RegExp(`${source.run.id}$`));
    await expect(
      page.getByText('Simulation: all tools use recorded fixtures.', { exact: false }),
    ).toBeVisible();
    const forkId = page.url().split('/').at(-1)!;
    const initial = await api('GET', `runs/${forkId}/detail`, runDetailSchema);
    await complete(initial.run.missionId);
    const fork = await api('GET', `runs/${forkId}/detail`, runDetailSchema);
    expect(fork.replay).toMatchObject({
      sourceRunId: source.run.id,
      sourceStepId: step!.id,
      mocked: true,
      model: { providerId: 'phase10-fixture', modelId: 'gpt-4o-mini' },
    });
    expect(fork.steps.some((item) => item.modelId === 'gpt-4o-mini')).toBe(true);
    expect(
      fork.steps
        .filter((item) => item.toolName)
        .every((item) => JSON.stringify(item.toolResult).includes('"simulation":true')),
    ).toBe(true);
    expect(fork.steps.filter((item) => item.toolName)).toHaveLength(1);
    expect(fork.steps.filter((item) => item.kind === 'assistant').at(-1)?.content).toContain(
      'Comparable Phase10 fixture summary',
    );
    expect((await api('GET', `runs/${source.run.id}/detail`, runDetailSchema)).steps).toEqual(
      before.steps,
    );
    expect(
      (await api('GET', 'memory/jobs', z.array(knowledgeJobSchema))).some(
        (job) => job.runId === forkId,
      ),
    ).toBe(false);
    await expect(page.getByRole('table', { name: 'Run comparison', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Run summary', exact: true })).toContainText(
      'Completed',
    );
    await page.screenshot({ path: info.outputPath('phase10-replay-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: info.outputPath('phase10-replay-mobile.png'), fullPage: true });
    expect(errors).toEqual([]);
    expect(model.failures).toEqual([]);
    await info.attach('phase10-replay-production-evidence', {
      contentType: 'application/json',
      body: JSON.stringify({
        sourceRunId: source.run.id,
        sourceMissionId: source.id,
        sourceStepId: step!.id,
        forkRunId: forkId,
        forkMissionId: fork.run.missionId,
        sourceCost: before.run.costUsd,
        forkCost: fork.run.costUsd,
        sourceSteps: before.steps.length,
        forkSteps: fork.steps.length,
        modelIds: [...new Set(model.requests.map((item) => item.model))],
        mockedToolCalls: fork.steps.filter((item) => item.toolName).length,
        errors,
      }),
    });
  } finally {
    await model.close();
  }
});

test('Phase 10 production: compare two presets in Evals and open an inert HTML report', async ({
  page,
  context,
}, info) => {
  test.setTimeout(300000);
  const { api, model, project, evalComplete } = await prepare(
    context,
    info,
    'Phase 10 evaluation comparison',
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('/evals');
    await expect(page.getByRole('heading', { name: 'Evaluations', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(project.id);
    await page.getByRole('button', { name: 'Run comparison', exact: true }).click();
    const selected = page.getByRole('region', { name: 'Selected evaluation', exact: true });
    await expect(selected.getByRole('status')).toContainText('12 passed', { timeout: 30000 });
    const link = selected.getByRole('link', { name: 'Open standalone HTML report', exact: true });
    const href = await link.getAttribute('href');
    const fixtureId = href!.split('/')[3]!;
    const fixture = await evalComplete(fixtureId);
    expect(fixture).toMatchObject({ mode: 'fixture', passedCases: 12, totalCases: 12, costUsd: 0 });
    expect(model.requests).toHaveLength(0);
    const [reportPage] = await Promise.all([context.waitForEvent('page'), link.click()]);
    await reportPage.waitForLoadState('domcontentloaded');
    await expect(
      reportPage.getByRole('heading', { name: 'Sazuz evaluation report', exact: true }),
    ).toBeVisible();
    const exported = evalReportSchema.parse(
      JSON.parse((await reportPage.locator('#report-data').textContent())!),
    );
    expect(exported.presets).toEqual(['balanced', 'budget']);
    expect(exported.suites).toHaveLength(3);
    expect(await reportPage.locator('table tbody tr').count()).toBe(6);
    expect(await reportPage.locator('script').count()).toBe(0);
    await reportPage.screenshot({
      path: info.outputPath('phase10-eval-report.png'),
      fullPage: true,
    });
    await reportPage.close();
    await page
      .getByRole('checkbox', {
        name: 'Use configured models (may incur model charges)',
        exact: true,
      })
      .check();
    await page
      .getByRole('checkbox', {
        name: 'Include an optional model judge; its cost is reported separately',
        exact: true,
      })
      .check();
    await page.getByRole('button', { name: 'Run comparison', exact: true }).click();
    await expect(link).not.toHaveAttribute('href', href!);
    const configuredId = (await link.getAttribute('href'))!.split('/')[3]!;
    const configured = await evalComplete(configuredId);
    expect(configured).toMatchObject({ mode: 'configured', passedCases: 12, totalCases: 12 });
    expect(configured.costUsd).toBeGreaterThan(0);
    expect(configured.judgeCostUsd).toBeGreaterThan(0);
    const redTeam = await api('POST', 'evals', evalRunSchema, {
      requestId: randomUUID(),
      projectId: project.id,
      suites: ['red-team'],
      presets: ['balanced', 'budget'],
      mode: 'configured',
      judge: false,
    });
    const adversarial = await evalComplete(redTeam.id);
    expect(adversarial).toMatchObject({ totalCases: 20, passedCases: 20 });
    const risky = adversarial.results
      .flatMap((item) => item.decisions)
      .filter((item) => ['send', 'delete', 'spend'].includes(item.effect));
    expect(risky.length).toBeGreaterThanOrEqual(16);
    expect(risky.every((item) => item.action === 'ask' || item.action === 'deny')).toBe(true);
    expect(
      adversarial.results
        .flatMap((item) => item.dispatches)
        .every((item) => item.effect === 'read'),
    ).toBe(true);
    expect(
      adversarial.results.every(
        (item) => item.unauthorizedEffects === 0 && item.liveDispatches === 0,
      ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath('phase10-evals-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: info.outputPath('phase10-evals-mobile.png'), fullPage: true });
    expect(errors).toEqual([]);
    expect(model.failures).toEqual([]);
    expect(JSON.stringify(model.requests)).not.toContain(phaseTenModelKey);
    await info.attach('phase10-evals-production-evidence', {
      contentType: 'application/json',
      body: JSON.stringify({
        fixtureId,
        configuredId,
        redTeamId: redTeam.id,
        fixtureCases: fixture.totalCases,
        configuredCases: configured.totalCases,
        configuredPassed: configured.passedCases,
        costUsd: configured.costUsd,
        judgeCostUsd: configured.judgeCostUsd,
        redTeamCases: adversarial.totalCases,
        riskyAttempts: risky.length,
        unauthorizedEffects: 0,
        liveDispatches: 0,
        modelRequests: model.requests.length,
        errors,
      }),
    });
  } finally {
    await model.close();
  }
});

test('Phase 10 production: inspect Costs and consent to metadata-only collector export', async ({
  page,
  context,
}, info) => {
  test.setTimeout(180000);
  const { api, model, project, evalComplete } = await prepare(
    context,
    info,
    'Phase 10 cost and collector checks',
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const credential = await api('POST', 'vault/secrets', z.object({ reference: z.string() }), {
      name: 'Phase 10 collector',
      value: phaseTenCollectorKey,
    });
    const current = await api('GET', 'settings', settingsDocumentSchema);
    await api('PUT', 'settings/advanced', z.unknown(), {
      expectedVersion: current.advanced.version,
      value: {
        ...current.advanced.value,
        telemetry: true,
        telemetryEndpoint: model.collectorUrl,
        telemetrySecretRef: credential.reference,
      },
    });
    const run = await api('POST', 'evals', evalRunSchema, {
      requestId: randomUUID(),
      projectId: project.id,
      suites: ['research'],
      presets: ['budget'],
      mode: 'configured',
      judge: false,
    });
    const report = await evalComplete(run.id);
    expect(report.passedCases).toBe(2);
    await expect
      .poll(() => model.collected.length, { timeout: 30000, intervals: [500, 1000] })
      .toBeGreaterThan(0);
    const summary = await api(
      'GET',
      `costs/dashboard?projectId=${project.id}`,
      costDashboardSchema,
    );
    expect(summary.costUsd).toBeCloseTo(report.costUsd, 8);
    expect(summary.groups.agent.some((item) => item.key === 'eval:research')).toBe(true);
    expect(summary.forecastUsd).toBeGreaterThanOrEqual(summary.costUsd);
    const telemetry = await api('GET', 'observability/status', telemetryStatusSchema);
    expect(telemetry.counts.done).toBeGreaterThan(0);
    expect(model.collected.every((item) => item.authorized)).toBe(true);
    const payload = JSON.stringify(model.collected);
    for (const marker of [
      phaseTenModelKey,
      phaseTenCollectorKey,
      'benchmark.txt',
      'https://docs.example.test/release',
      'gpt-4o',
      project.id,
    ])
      expect(payload).not.toContain(marker);
    await page.goto('/costs');
    await page
      .getByRole('combobox', { name: 'Project scope', exact: true })
      .selectOption(project.id);
    await expect(page.getByRole('region', { name: 'Spending summary', exact: true })).toContainText(
      'Month-end forecast',
    );
    await expect(page.getByRole('region', { name: 'Telemetry export', exact: true })).toContainText(
      'enabled',
    );
    await page.screenshot({ path: info.outputPath('phase10-costs-desktop.png'), fullPage: true });
    await page.goto('/settings?section=advanced');
    await expect(
      page.getByRole('checkbox', { name: 'Enable OpenTelemetry export', exact: true }),
    ).toBeChecked();
    await expect(page.getByRole('textbox', { name: /^OTLP\/HTTP traces endpoint/ })).toHaveValue(
      model.collectorUrl,
    );
    await page
      .getByRole('checkbox', { name: 'Enable OpenTelemetry export', exact: true })
      .uncheck();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect
      .poll(async () => (await api('GET', 'observability/status', telemetryStatusSchema)).enabled)
      .toBe(false);
    await page.goto('/costs');
    await expect(page.getByRole('region', { name: 'Telemetry export', exact: true })).toContainText(
      'off',
    );
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: info.outputPath('phase10-costs-mobile.png'), fullPage: true });
    expect(errors).toEqual([]);
    expect(model.failures).toEqual([]);
    await info.attach('phase10-costs-production-evidence', {
      contentType: 'application/json',
      body: JSON.stringify({
        projectId: project.id,
        evaluationId: run.id,
        costUsd: summary.costUsd,
        forecastUsd: summary.forecastUsd,
        collectorRequests: model.collected.length,
        exported: telemetry.counts.done,
        allAuthorized: model.collected.every((item) => item.authorized),
        metadataOnly: true,
        disabledAfterCheck: true,
        errors,
      }),
    });
  } finally {
    await model.close();
  }
});
