import { expect, test } from '@playwright/test';
import { z } from 'zod';
import { settingsDocumentSchema } from '@sazuz/config/settings';
import { browserProfileSchema, browserSessionSchema } from '@sazuz/core/browser';
import { missionDetailSchema, missionSchema } from '@sazuz/core/missions';
import { projectSchema } from '@sazuz/core/work';
import { phaseFiveModelKey, startPhaseFiveModel } from './phase-five-model';
import { waitForProductionExtractions } from './production-jobs';

const canary = 'phase5-production-form-canary-925174';
const statsSchema = z.strictObject({
  submissions: z.number().int(),
  loginReceived: z.boolean(),
  detailsReceived: z.boolean(),
  scrollY: z.number(),
});

test('Phase 5 production: live login, reconnect, wheel and mobile controls, handback and one reviewed submission', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(240000);
  const fixtureOrigin = process.env.PLAYWRIGHT_PHASE5_FIXTURE_ORIGIN;
  test.skip(
    !fixtureOrigin,
    'Requires the test-only host browser fixture connected to the fresh production database.',
  );
  if (!fixtureOrigin) return;
  const endpoint = new URL(fixtureOrigin);
  expect(endpoint.hostname).toBe('127.0.0.1');
  const origin = z.string().parse(testInfo.project.use.baseURL);
  const fixture = await startPhaseFiveModel();
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  const upgradePaths: string[] = [];
  let frames = 0;
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/live/browser/')) return;
    upgradePaths.push(socket.url());
    socket.on('framereceived', (event) => {
      if (String(event.payload).includes('"type":"frame"')) frames++;
    });
  });
  const api = async <T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown) => {
    const response = await context.request.fetch(`/api/${path}`, {
      method,
      headers: { origin },
      ...(body === undefined ? {} : { data: body }),
    });
    expect(response.status(), `${method} ${path}`).toBe(200);
    const source = await response.text();
    expect(source).not.toContain(canary);
    expect(source).not.toContain(phaseFiveModelKey);
    return schema.parse(JSON.parse(source));
  };
  const stats = async () =>
    statsSchema.parse(
      await (await context.request.get(new URL('/fixture/status', endpoint).href)).json(),
    );
  try {
    await api('POST', 'auth/sign-in/email', z.unknown(), {
      email: 'browser-owner@example.test',
      password: 'Browser-admin-password-7814',
    });
    const credential = await api('POST', 'vault/secrets', z.object({ reference: z.string() }), {
      name: 'Phase 5 model fixture',
      value: phaseFiveModelKey,
    });
    let settings = await api('GET', 'settings', settingsDocumentSchema);
    await api('PUT', 'settings/providers', z.unknown(), {
      expectedVersion: settings.providers.version,
      value: {
        items: [
          {
            id: 'phase5-fixture',
            name: 'Local form model',
            kind: 'openai-compatible',
            baseUrl: fixture.baseUrl,
            secretRef: credential.reference,
            locality: 'local',
            enabled: true,
          },
        ],
      },
    });
    await api('POST', 'providers/phase5-fixture/discover', z.unknown(), {});
    settings = await api('GET', 'settings', settingsDocumentSchema);
    const model = { providerId: 'phase5-fixture', modelId: 'gpt-4o' };
    await api('PUT', 'settings/models', z.unknown(), {
      expectedVersion: settings.models.version,
      value: {
        ...settings.models.value,
        roles: { ...settings.models.value.roles, executor: model, fast: model, vision: model },
        modelLimits: [{ ...model, contextWindow: 131072, maxOutput: 2048 }],
        providerRateLimits: [{ providerId: model.providerId, requestsPerMinute: 600, burst: 50 }],
      },
    });
    await api('PUT', 'settings/security', z.unknown(), {
      expectedVersion: settings.security.version,
      value: {
        ...settings.security.value,
        agentDomains: [
          ...settings.security.value.agentDomains.filter((value) => value.agentId !== 'operator'),
          { agentId: 'operator', domains: ['fixture.example'] },
        ],
      },
    });
    const project = await api('POST', 'projects', projectSchema, {
      name: 'Phase 5 live form',
      privacy: 'private',
    });
    await page.goto('/browser');
    await page.getByLabel('Project', { exact: true }).selectOption(project.id);
    await page.getByLabel('Profile name', { exact: true }).fill('Production form');
    await page.getByLabel('HTTPS site', { exact: true }).fill('https://fixture.example');
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();
    const card = page
      .getByRole('region', { name: 'Site profiles' })
      .getByRole('article')
      .filter({ hasText: 'Production form' });
    await card.getByText('Start an Operator mission', { exact: true }).click();
    await card
      .getByLabel('What should the agent do?')
      .fill('Complete the project form with Launch project in West.');
    const createdResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/missions' &&
        response.request().method() === 'POST',
    );
    await card.getByRole('button', { name: 'Start mission', exact: true }).click();
    const mission = missionSchema.parse(await (await createdResponse).json());
    let approvals = 0;
    async function advance(target: 'paused' | 'completed') {
      let latest: z.infer<typeof missionDetailSchema> | undefined;
      await expect
        .poll(
          async () => {
            latest = await api('GET', `missions/${mission.id}`, missionDetailSchema);
            const approval = latest.approvals.find((value) => value.status === 'pending');
            if (approval) {
              await api('POST', `approvals/${approval.id}/decision`, z.unknown(), {
                action: 'approve',
                version: approval.version,
                note: '',
              });
              approvals++;
            }
            return latest.mission.run.status;
          },
          { timeout: 60000, intervals: [250, 500, 1000] },
        )
        .toBe(target);
      return latest!;
    }
    const paused = await advance('paused');
    expect(paused.mission.run.tainted).toBe(true);
    const session = (await api('GET', 'browser/sessions', z.array(browserSessionSchema))).find(
      (value) => value.runId === mission.run.id,
    )!;
    expect(session.control).toBe('human');
    await page.goto('/browser');
    await page.getByRole('button', { name: 'View session', exact: true }).last().click();
    const live = page.getByRole('region', { name: 'Live browser', exact: true });
    await expect(live.getByText('Live view connected.', { exact: true })).toBeVisible();
    await expect.poll(() => frames).toBeGreaterThan(0);
    await expect(live.getByLabel('Text for the focused site field')).toBeEnabled();
    await live.getByLabel('Text for the focused site field').fill('fixture-owner');
    await live.getByRole('button', { name: 'Send text', exact: true }).click();
    await live.getByRole('button', { name: 'Tab', exact: true }).click();
    await live.getByLabel('Text for the focused site field').fill(canary);
    await live.getByRole('button', { name: 'Send text', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('phase5-live-login.png'), fullPage: true });
    await live.getByRole('button', { name: 'Enter', exact: true }).click();
    await expect.poll(async () => (await stats()).loginReceived).toBe(true);
    const canvas = live.getByRole('application', { name: 'Remote browser view' });
    await expect
      .poll(async () =>
        canvas.evaluate(
          (element) =>
            (element as HTMLCanvasElement).getContext('2d')?.getImageData(10, 10, 1, 1).data[3],
        ),
      )
      .toBe(255);
    await canvas.hover();
    await page.waitForTimeout(100); // Keep the wheel event outside the pointer-move throttle window.
    await page.mouse.wheel(0, 500);
    await expect.poll(async () => (await stats()).scrollY).toBeGreaterThan(0);
    await page.goto('/health');
    const diagnostics = page.getByRole('region', { name: 'Execution diagnostics' });
    await expect(diagnostics.getByText('Chromium is running.', { exact: false })).toBeVisible();
    expect(
      (await api('GET', `missions/${mission.id}`, missionDetailSchema)).mission.run.status,
    ).toBe('paused');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/browser');
    await page.getByRole('button', { name: 'View session', exact: true }).last().click();
    await expect(live.getByText('Live view connected.', { exact: true })).toBeVisible();
    await expect(live.getByRole('button', { name: 'Scroll up', exact: true })).toBeEnabled();
    await live.getByRole('button', { name: 'Scroll up', exact: true }).click();
    await expect.poll(async () => (await stats()).scrollY).toBe(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await live.getByRole('button', { name: 'Hand back and resume', exact: true }).click();
    const completed = await advance('completed');
    await waitForProductionExtractions(context.request, [completed.mission.run.id]);
    expect(completed.steps.some((step) => step.content.includes('fixture-42'))).toBe(true);
    expect(completed.steps.some((step) => step.content.includes('withheld'))).toBe(true);
    expect(await stats()).toMatchObject({
      loginReceived: true,
      detailsReceived: true,
      submissions: 1,
    });
    expect(approvals).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(fixture.requests)).not.toContain(canary);
    expect(fixture.failures).toEqual([]);
    expect(failures).toEqual([]);
    expect(upgradePaths.length).toBeGreaterThanOrEqual(2);
    for (const url of upgradePaths) {
      expect(new URL(url).host).toBe(new URL(origin).host);
      expect(new URL(url).search).toBe('');
    }
    await page.goto('/browser');
    await card.getByRole('button', { name: 'Wipe profile', exact: true }).click();
    await expect(card).toHaveCount(0);
    expect(
      (await api('GET', 'browser/profiles', z.array(browserProfileSchema))).find(
        (value) => value.id === session.profileId,
      ),
    ).toMatchObject({ retired: true, hasSavedState: false });
    await page.screenshot({
      path: testInfo.outputPath('phase5-browser-mobile.png'),
      fullPage: true,
    });
    await testInfo.attach('phase5-production-evidence', {
      body: JSON.stringify({
        frames,
        connections: upgradePaths.length,
        approvals,
        submissions: 1,
        loginCanaryAbsentFromEvidence: true,
        wheel: true,
        mobile: true,
        profileWiped: true,
      }),
      contentType: 'application/json',
    });
  } finally {
    await fixture.close();
  }
});
