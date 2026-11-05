import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { z } from 'zod';
import { settingsDocumentSchema } from '@sazuz/config/settings';
import { projectSchema } from '@sazuz/core/work';
import { missionDetailSchema, missionSchema } from '@sazuz/core/missions';
import { memorySchema } from '@sazuz/core/memory';
import { sourceSchema } from '@sazuz/core/knowledge';
import { skillSummarySchema } from '@sazuz/core/skills';
import { recipeInstallationSchema } from '@sazuz/core/recipes';
import { waitForProductionExtractions } from './production-jobs';
import {
  phaseFourModelKey,
  preferenceStatement,
  rememberedPreference,
  selectedBodyMarker,
  startPhaseFourModel,
} from './phase-four-model';

// The complete production suite runs this after setup.spec.ts on its disposable installation.
test('Phase 4 production: scoped memory, citations, selected skills, style and recipe review', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(180_000);
  test.skip(
    !process.env.PLAYWRIGHT_SETUP_DATA_DIR,
    'Requires the fresh disposable production stack and its setup acceptance case.',
  );
  const origin = z.string().parse(testInfo.project.use.baseURL);
  const fixture = await startPhaseFourModel();
  const api = async <T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown) => {
    const response = await context.request.fetch(`/api/${path}`, {
      method,
      headers: { origin },
      ...(body === undefined ? {} : { data: body }),
    });
    expect(response.status(), `${method} ${path}`).toBe(200);
    expect(await response.text()).not.toContain(phaseFourModelKey);
    const value: unknown = await response.json();
    return schema.parse(value);
  };
  try {
    await api('POST', 'auth/sign-in/email', z.unknown(), {
      email: 'browser-owner@example.test',
      password: 'Browser-admin-password-7814',
    });
    const credential = await api('POST', 'vault/secrets', z.object({ reference: z.string() }), {
      name: 'Phase 4 HTTP fixture',
      value: phaseFourModelKey,
    });
    let settings = await api('GET', 'settings', settingsDocumentSchema);
    await api('PUT', 'settings/providers', z.unknown(), {
      expectedVersion: settings.providers.version,
      value: {
        items: [
          {
            id: 'phase4-fixture',
            name: 'Local protocol fixture',
            kind: 'openai-compatible',
            baseUrl: fixture.baseUrl,
            secretRef: credential.reference,
            locality: 'local',
            enabled: true,
          },
        ],
      },
    });
    await api('POST', 'providers/phase4-fixture/discover', z.unknown(), {});
    settings = await api('GET', 'settings', settingsDocumentSchema);
    const model = { providerId: 'phase4-fixture', modelId: 'gpt-4o' };
    await api('PUT', 'settings/models', z.unknown(), {
      expectedVersion: settings.models.version,
      value: {
        ...settings.models.value,
        modelLimits: [
          {
            providerId: model.providerId,
            modelId: model.modelId,
            contextWindow: 131072,
            maxOutput: 2048,
          },
        ],
        roles: { ...settings.models.value.roles, planner: model, executor: model, fast: model },
        providerRateLimits: [{ providerId: model.providerId, requestsPerMinute: 600, burst: 50 }],
      },
    });
    const project = await api('POST', 'projects', projectSchema, {
      name: 'Phase 4 browser acceptance',
      privacy: 'private',
    });
    async function mission(goal: string) {
      const created = await api('POST', 'missions', missionSchema, {
        projectId: project.id,
        goal,
        agent: 'researcher',
        requestId: randomUUID(),
      });
      let detail: z.infer<typeof missionDetailSchema> | undefined;
      await expect
        .poll(
          async () => {
            detail = await api('GET', `missions/${created.id}`, missionDetailSchema);
            return ['completed', 'failed', 'cancelled', 'budget_exceeded'].includes(
              detail.mission.run.status,
            );
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      expect(
        detail!.mission.run.status,
        JSON.stringify({
          reason: detail!.mission.run.reason,
          fixtureRequests: fixture.requests.length,
          fixtureFailures: fixture.failures,
        }),
      ).toBe('completed');
      return detail!;
    }
    await test.step('review a source-supported preference and use it in another thread', async () => {
      const source = await mission(`${preferenceStatement} Remember this preference.`);
      await page.goto('/memory');
      await expect
        .poll(
          async () =>
            (await api('GET', 'memory', z.array(memorySchema))).filter(
              (item) => item.sourceRunId === source.mission.run.id,
            ).length,
          { timeout: 30_000 },
        )
        .toBe(1);
      // Controlled textareas expose their current value rather than a text node.
      const proposal = page
        .getByRole('article', { name: 'preference memory' })
        .filter({ hasText: preferenceStatement });
      await expect(proposal.getByLabel('Memory text')).toHaveValue(rememberedPreference);
      await proposal.getByRole('button', { name: 'Accept memory' }).click();
      await expect(proposal.getByText('accepted', { exact: true })).toBeVisible();
      const second = await mission('Write a concise reply to Alex about the agenda.');
      expect(second.mission.threadId).not.toBe(source.mission.threadId);
      expect(
        second.steps
          .filter((step) => step.kind === 'assistant')
          .some((step) => step.prompt?.includes(rememberedPreference)),
      ).toBe(true);
      expect(second.steps.some((step) => step.content.includes('as you prefer'))).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('phase4-memory.png'), fullPage: true });
    });
    await test.step('delete the preference and immediately verify a new prompt excludes it', async () => {
      await page.goto('/memory');
      const proposal = page
        .getByRole('article', { name: 'preference memory' })
        .filter({ hasText: preferenceStatement });
      await proposal.getByRole('button', { name: 'Delete memory' }).click();
      await expect(proposal).toHaveCount(0);
      const after = await mission('Write another concise reply about the agenda.');
      expect(
        after.steps
          .filter((step) => step.kind === 'assistant')
          .every((step) => !step.prompt?.includes(rememberedPreference)),
      ).toBe(true);
    });
    await test.step('upload knowledge, retrieve it and follow the answer citation', async () => {
      await page.goto('/knowledge');
      await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(project.id);
      await page.getByLabel('Document', { exact: true }).setInputFiles({
        name: 'orion-launch.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from(
          '# Orion launch\n\nOrion launches on 14 November. The launch owner is Morgan.\n',
        ),
      });
      await page.getByRole('button', { name: 'Upload document' }).click();
      await expect
        .poll(
          async () =>
            (await api('GET', `kb/sources?projectId=${project.id}`, z.array(sourceSchema))).some(
              (source) => source.name === 'orion-launch.md' && source.status === 'ready',
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      const answer = await mission('When does Orion launch? Answer from the project documents.');
      const citation = answer.steps
        .map((step) => step.content)
        .join('\n')
        .match(/\[kb:(chk_[0-9A-HJKMNP-TV-Z]{26})\]/)?.[1];
      expect(citation).toBeTruthy();
      await page.goto(`/missions/${answer.mission.id}`);
      await page
        .getByRole('link', { name: `[kb:${citation}]`, exact: true })
        .first()
        .click();
      await expect(
        page.getByRole('heading', { name: 'Source citation', exact: true }),
      ).toBeVisible();
      await expect(page.getByText(/Orion launches on 14 November/)).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('phase4-citation.png'), fullPage: true });
    });
    await test.step('edit a skill and inspect prompts before and after selection', async () => {
      await page.goto('/skills');
      const editor = page.getByRole('region', { name: 'Skill editor' });
      await editor
        .getByRole('textbox', { name: 'SKILL.md', exact: true })
        .fill(
          `---\nname: browser-procedure\ndescription: A procedure for browser acceptance.\nversion: 1.0.0\ninputs:\n  type: object\n  properties: {}\ntools: []\npermissions: [read]\n---\n# Browser procedure\n${selectedBodyMarker}\nUse concise sentences.\n`,
        );
      await editor.getByRole('button', { name: 'Save skill', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('Saved revision 1');
      const detail = await mission('Select browser-procedure and apply its instructions.');
      const prompts = detail.steps
        .filter((step) => step.kind === 'assistant')
        .map((step) => step.prompt ?? '');
      expect(prompts[0]).toContain('browser-procedure');
      expect(prompts[0]).not.toContain(selectedBodyMarker);
      expect(prompts[1]).toContain(selectedBodyMarker);
      await page.goto(`/missions/${detail.mission.id}`);
      const inspector = page
        .locator('details')
        .filter({ has: page.locator('summary', { hasText: 'Model prompt' }) });
      await inspector.nth(0).locator('summary').click();
      await expect(inspector.nth(0).locator('pre')).not.toContainText(selectedBodyMarker);
      await inspector.nth(1).locator('summary').click();
      await expect(inspector.nth(1).locator('pre')).toContainText(selectedBodyMarker);
      await page.screenshot({ path: testInfo.outputPath('phase4-prompts.png'), fullPage: true });
      await page.goto('/skills');
      await page
        .getByRole('textbox', { name: 'Writing sample', exact: true })
        .fill('Hi Jo, please review the agenda before tomorrow. Keep the comments short. Thanks.');
      await page.getByRole('button', { name: 'Generate style preview', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Accept writing style' })).toBeVisible({
        timeout: 30_000,
      });
      expect(
        (await api('GET', 'skills', z.array(skillSummarySchema))).some(
          (skill) => skill.name === 'writing-style',
        ),
      ).toBe(false);
      await page.getByRole('button', { name: 'Accept writing style' }).click();
      await expect(page.getByText(/Style accepted/)).toBeVisible();
      expect(
        (await api('GET', 'skills', z.array(skillSummarySchema))).some(
          (skill) => skill.name === 'writing-style',
        ),
      ).toBe(true);
    });
    await test.step('review and install Knowledge Q&A in a mobile viewport', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/recipes');
      await page.getByRole('button', { name: 'Knowledge Q&A', exact: true }).click();
      await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(project.id);
      await page.getByRole('textbox', { name: /^Question\b/ }).fill('When does Orion launch?');
      await page.getByRole('button', { name: 'Preview recipe', exact: true }).click();
      const preview = page.getByRole('region', { name: 'Recipe preview' });
      await expect(preview.getByRole('heading', { name: 'Review Knowledge Q&A' })).toBeVisible();
      expect(
        (await api('GET', 'recipes/installations', z.array(recipeInstallationSchema)))[0]
          ?.installedAt,
      ).toBeNull();
      await preview.getByRole('button', { name: 'Install and run', exact: true }).click();
      await expect(preview.getByRole('link', { name: 'View mission' })).toBeVisible();
      const installed = (
        await api('GET', 'recipes/installations', z.array(recipeInstallationSchema))
      )[0]!;
      expect(
        (await api('POST', `recipes/${installed.id}/install`, recipeInstallationSchema, {}))
          .missionId,
      ).toBe(installed.missionId);
      await expect
        .poll(
          async () =>
            (await api('GET', `missions/${installed.missionId}`, missionDetailSchema)).mission.run
              .status,
          { timeout: 30_000 },
        )
        .toBe('completed');
      const completed = await api('GET', `missions/${installed.missionId}`, missionDetailSchema);
      await waitForProductionExtractions(context.request, [completed.mission.run.id]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath('phase4-recipes-mobile.png'),
        fullPage: true,
      });
    });
    expect(fixture.failures).toEqual([]);
    expect(fixture.requests.length).toBeGreaterThan(5);
    expect(JSON.stringify(fixture.requests)).not.toContain(phaseFourModelKey);
    await testInfo.attach('phase4-production-evidence', {
      body: JSON.stringify(
        {
          completed: [
            'cross-thread memory',
            'immediate deletion',
            'source citation',
            'progressive skill prompts',
            'style review',
            'recipe installation replay',
          ],
          fixtureHttpRequests: fixture.requests.length,
          credentialAbsent: true,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  } finally {
    await testInfo.attach('fixture-diagnostics', {
      body: JSON.stringify(
        {
          requests: fixture.requests.length,
          failures: fixture.failures,
          formats: fixture.requests.map((request) => ({
            roles: request.messages.map((message) => message.role),
            structured: !!request.response_format,
            tools: request.tools?.length ?? 0,
          })),
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    await fixture.close();
  }
});
