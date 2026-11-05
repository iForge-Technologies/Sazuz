import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type TestInfo } from '@playwright/test';
import { z } from 'zod';
import { settingsDocumentSchema } from '@sazuz/config/settings';
import { browserProfileSchema, browserSessionSchema } from '@sazuz/core/browser';
import { learnedDraftSchema, learnedVersionSchema, recordingSchema } from '@sazuz/core/learning';
import { learnedReplaySchema, learnedRepairSchema } from '@sazuz/core/learning-replay';
import { missionDetailSchema, missionSchema } from '@sazuz/core/missions';
import { skillProposalSchema } from '@sazuz/core/proposals';
import { skillVersionSchema, styleProfileSchema } from '@sazuz/core/skills';
import { styleComparisonSchema } from '@sazuz/core/style';
import { projectSchema } from '@sazuz/core/work';
import { phaseNineModelKey, phaseNineStyleTrait, startPhaseNineModel } from './phase-nine-model';
import { waitForProductionExtractions } from './production-jobs';

const recordedValue = 'phase9-recorded-text-canary-492157';
const learningStateSchema = z.strictObject({
  path: z.string(),
  submissions: z.array(z.record(z.string(), z.string())),
  focus: z.string(),
  lengths: z.record(z.string(), z.number().int().nonnegative()),
  confirmed: z.boolean(),
});

async function prepare(context: BrowserContext, info: TestInfo, name: string) {
  const origin = z.string().parse(info.project.use.baseURL);
  const model = await startPhaseNineModel();
  const api = async <T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown) => {
    const response = await context.request.fetch(`/api/${path}`, {
      method,
      headers: { origin },
      ...(body === undefined ? {} : { data: body }),
    });
    expect(response.status(), `${method} ${path}`).toBe(200);
    const source = await response.text();
    expect(source).not.toContain(phaseNineModelKey);
    expect(source).not.toContain(recordedValue);
    return schema.parse(JSON.parse(source));
  };
  try {
    await api('POST', 'auth/sign-in/email', z.unknown(), {
      email: 'browser-owner@example.test',
      password: 'Browser-admin-password-7814',
    });
    const credential = await api('POST', 'vault/secrets', z.object({ reference: z.string() }), {
      name: 'Phase 9 model fixture',
      value: phaseNineModelKey,
    });
    let settings = await api('GET', 'settings', settingsDocumentSchema);
    await api('PUT', 'settings/providers', z.unknown(), {
      expectedVersion: settings.providers.version,
      value: {
        items: [
          {
            id: 'phase9-fixture',
            name: 'Phase 9 local model',
            kind: 'openai-compatible',
            baseUrl: model.baseUrl,
            secretRef: credential.reference,
            locality: 'local',
            enabled: true,
          },
        ],
      },
    });
    await api('POST', 'providers/phase9-fixture/discover', z.unknown(), {});
    settings = await api('GET', 'settings', settingsDocumentSchema);
    const assignment = { providerId: 'phase9-fixture', modelId: 'gpt-4o' };
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
        providerRateLimits: [
          { providerId: assignment.providerId, requestsPerMinute: 600, burst: 50 },
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
      value: {
        ...settings.security.value,
        agentDomains: [
          ...settings.security.value.agentDomains.filter((item) => item.agentId !== 'operator'),
          { agentId: 'operator', domains: ['fixture.example'] },
        ],
      },
    });
    await api('PUT', 'settings/budgets', z.unknown(), {
      expectedVersion: settings.budgets.version,
      value: { ...settings.budgets.value, maxSteps: 100, perRunUsd: 2, maxWallTimeSeconds: 240 },
    });
    const project = await api('POST', 'projects', projectSchema, {
      name,
      privacy: 'private',
      budgetUsd: 10,
    });
    async function complete(id: string) {
      let detail: z.infer<typeof missionDetailSchema> | undefined;
      let approvals = 0;
      await expect
        .poll(
          async () => {
            detail = await api('GET', `missions/${id}`, missionDetailSchema);
            const pending = detail.approvals.find((item) => item.status === 'pending');
            if (pending) {
              expect(pending.kind).toBe('policy');
              await api('POST', `approvals/${pending.id}/decision`, z.unknown(), {
                action: 'approve',
                version: pending.version,
                note: '',
              });
              approvals++;
            }
            return ['completed', 'failed', 'cancelled', 'budget_exceeded', 'paused'].includes(
              detail.mission.run.status,
            );
          },
          { timeout: 150000, intervals: [250, 500, 1000] },
        )
        .toBe(true);
      expect(detail!.mission.run.status, detail!.mission.run.reason ?? 'run result').toBe(
        'completed',
      );
      return { detail: detail!, approvals };
    }
    return { api, model, project, complete };
  } catch (error) {
    await model.close();
    throw error;
  }
}

test('Phase 9 production: record eight actions, review parameters, rehearse, replay and accept a DOM repair', async ({
  page,
  context,
}, info) => {
  test.setTimeout(360000);
  const fixtureOrigin = process.env.PLAYWRIGHT_PHASE5_FIXTURE_ORIGIN;
  test.skip(!fixtureOrigin, 'Requires the fresh production stack with the test-only host browser.');
  if (!fixtureOrigin) return;
  const endpoint = new URL(fixtureOrigin);
  expect(endpoint.hostname).toBe('127.0.0.1');
  const { api, model, project, complete } = await prepare(
    context,
    info,
    'Phase 9 learned browser workflow',
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = async () =>
    learningStateSchema.parse(
      await (await context.request.get(new URL('/fixture/learning', endpoint).href)).json(),
    );
  try {
    const profile = await api('POST', 'browser/profiles', browserProfileSchema, {
      projectId: project.id,
      name: 'Phase 9 demonstration',
      agentId: 'operator',
      site: 'https://fixture.example',
    });
    const source = await api('POST', 'missions', missionSchema, {
      projectId: project.id,
      agent: 'operator',
      requestId: randomUUID(),
      goal: `Phase9 recording bootstrap. Open profile ${profile.id} at https://fixture.example/learn and request review.`,
    });
    await expect
      .poll(
        async () => {
          const detail = await api('GET', `missions/${source.id}`, missionDetailSchema);
          const pending = detail.approvals.find((item) => item.status === 'pending');
          if (pending?.toolName === 'browser.click') return true;
          if (pending) {
            expect(['browser.open', 'browser.navigate']).toContain(pending.toolName);
            await api('POST', `approvals/${pending.id}/decision`, z.unknown(), {
              action: 'approve',
              version: pending.version,
              note: '',
            });
          }
          return false;
        },
        { timeout: 60000, intervals: [250, 500, 1000] },
      )
      .toBe(true);
    const session = (await api('GET', 'browser/sessions', z.array(browserSessionSchema))).find(
      (item) => item.runId === source.run.id,
    )!;
    await page.goto('/browser');
    await page.getByRole('button', { name: 'View session', exact: true }).last().click();
    const live = page.getByRole('region', { name: 'Live browser', exact: true });
    await expect(live.getByText('Live view connected.', { exact: true })).toBeVisible();
    await live.getByRole('button', { name: 'Take control', exact: true }).click();
    await expect(live.getByLabel('Text for the focused site field')).toBeEnabled();
    await live.getByLabel('Recording name').fill('Phase 9 eight-action demo');
    await live.getByRole('button', { name: 'Record task', exact: true }).click();
    await expect(
      live.getByText('Recording. Stop before handing back control.', { exact: false }),
    ).toBeVisible();
    const canvas = live.getByRole('application', { name: 'Remote browser view' });
    const fill = async (field: string, value: string) => {
      await expect.poll(async () => (await state()).focus).toBe(field);
      await live.getByLabel('Text for the focused site field').fill(value);
      await live.getByRole('button', { name: 'Send text', exact: true }).click();
      await expect.poll(async () => (await state()).lengths[field]).toBe(value.length);
    };
    const tab = async (field: string) => {
      await live.getByRole('button', { name: 'Tab', exact: true }).click();
      await expect.poll(async () => (await state()).focus).toBe(field);
    };
    // Wait for delivered field/focus changes rather than overrun the bounded live-input queue.
    await fill('project', recordedValue);
    await tab('client');
    await fill('client', 'Original client');
    await tab('category');
    await canvas.press('ArrowDown');
    await expect.poll(async () => (await state()).lengths['category']).toBe(4);
    await tab('review');
    await live.getByRole('button', { name: 'Enter', exact: true }).click();
    await expect.poll(async () => (await state()).path).toBe('/learn-review');
    await fill('notes', 'Original notes');
    await tab('confirmed');
    await canvas.press('Space');
    await expect.poll(async () => (await state()).confirmed).toBe(true);
    await tab('submit');
    await live.getByRole('button', { name: 'Enter', exact: true }).click();
    await expect.poll(async () => (await state()).submissions.length).toBe(1);
    await live.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await expect(live.getByText('Recording saved with 8 actions.', { exact: false })).toBeVisible();
    const recording = (await api('GET', 'skills/recordings', z.array(recordingSchema))).find(
      (item) => item.sessionId === session.id,
    )!;
    expect(recording.events.filter((event) => event.replay)).toHaveLength(8);
    expect(JSON.stringify(recording)).not.toContain('Original client');
    const current = (await api('GET', 'browser/sessions', z.array(browserSessionSchema))).find(
      (item) => item.id === session.id,
    )!;
    await api('DELETE', `browser/sessions/${session.id}`, z.unknown(), {
      version: current.version,
    });
    const held = await api('GET', `missions/${source.id}`, missionDetailSchema);
    await api('POST', `runs/${source.run.id}/control`, z.unknown(), {
      action: 'cancel',
      version: held.mission.run.version,
    });
    await page.goto('/skills');
    const learning = page.getByRole('region', { name: 'Learned browser skills' });
    await learning.getByRole('button', { name: 'Phase 9 eight-action demo', exact: true }).click();
    await learning.getByLabel('Learned skill name').fill('phase-nine-project');
    for (const name of ['Project', 'Client', 'Category', 'Notes'])
      await learning.getByLabel(`Parameter for ${name}`, { exact: true }).fill(name.toLowerCase());
    const generatedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/skills/recordings/${recording.id}/generate`) &&
        response.request().method() === 'POST',
    );
    await learning.getByRole('button', { name: 'Generate learned skill', exact: true }).click();
    const generated = learnedDraftSchema.parse(await (await generatedResponse).json());
    expect(generated.status).toBe('ready');
    expect(generated.program?.steps).toHaveLength(8);
    const savedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/skills/learned' &&
        response.request().method() === 'POST',
    );
    await learning
      .getByRole('button', { name: 'Review and save learned skill', exact: true })
      .click();
    const saved = learnedVersionSchema.parse(await (await savedResponse).json());
    expect(saved.skill.revision).toBe(1);
    const library = page.getByRole('heading', { name: 'Skill library', exact: true }).locator('..');
    await library.getByRole('button', { name: 'phase-nine-project', exact: true }).click();
    const replay = page.getByRole('region', { name: 'Learned skill replay' });
    const newInputs = {
      project: 'New project',
      client: 'New client',
      category: 'Alpha',
      notes: 'New notes',
    };
    await replay.getByLabel('Inputs (JSON)').fill(JSON.stringify(newInputs));
    await replay
      .getByRole('combobox', { name: 'Browser profile', exact: true })
      .selectOption(profile.id);
    const baseline = model.requests.length;
    await replay.getByRole('button', { name: 'Rehearse without site access', exact: true }).click();
    await expect(
      replay.getByText('8 actions simulated against the recorded targets. No site was contacted.', {
        exact: true,
      }),
    ).toBeVisible();
    expect(model.requests).toHaveLength(baseline);
    expect((await state()).submissions).toHaveLength(1);
    const startLive = async () => {
      const response = page.waitForResponse(
        (value) =>
          value.url().endsWith(`/api/skills/learned/${saved.skill.id}/replays`) &&
          value.request().method() === 'POST',
      );
      await replay.getByRole('button', { name: 'Run live with approvals', exact: true }).click();
      return learnedReplaySchema.parse(await (await response).json());
    };
    const first = await startLive();
    const firstResult = await complete(first.missionId!);
    expect(firstResult.approvals).toBeGreaterThan(0);
    expect(firstResult.detail.mission.run.tainted).toBe(true);
    expect(firstResult.detail.mission.run.costUsd).toBe(0);
    expect(model.requests).toHaveLength(baseline);
    expect((await state()).submissions).toEqual([
      expect.anything(),
      { ...newInputs, confirmed: 'on' },
    ]);
    expect(
      (await context.request.post(new URL('/fixture/learning/change', endpoint).href)).status(),
    ).toBe(200);
    await replay.getByRole('button', { name: 'New run', exact: true }).click();
    await replay
      .getByLabel('Inputs (JSON)')
      .fill(JSON.stringify({ ...newInputs, project: 'Changed DOM project' }));
    const repaired = await startLive();
    const repairedResult = await complete(repaired.missionId!);
    expect(repairedResult.detail.mission.run.costUsd).toBeGreaterThan(0);
    expect(model.categories.filter((category) => category === 'repair')).toHaveLength(1);
    expect((await state()).submissions).toHaveLength(3);
    const patches = await api(
      'GET',
      `skills/learned/${saved.skill.id}/repairs`,
      z.array(learnedRepairSchema),
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      status: 'proposed',
      target: { name: 'Continue to summary' },
      acceptedRevision: null,
    });
    expect(
      (await api('GET', `skills/learned/${saved.skill.id}`, learnedVersionSchema)).skill.revision,
    ).toBe(1);
    await replay.getByRole('button', { name: 'Refresh history', exact: true }).click();
    await replay
      .getByRole('button', { name: 'Accept patch as a new revision', exact: true })
      .click();
    await expect(replay.getByRole('heading', { level: 2 })).toContainText('revision 2');
    expect(
      (await api('GET', `skills/learned/${saved.skill.id}?revision=1`, learnedVersionSchema))
        .programHash,
    ).toBe(saved.programHash);
    expect(JSON.stringify(model.requests)).not.toContain(recordedValue);
    expect(model.failures).toEqual([]);
    expect(errors).toEqual([]);
    await replay.screenshot({ path: info.outputPath('phase9-reviewed-repair.png') });
    await info.attach('phase9-browser-production-evidence', {
      contentType: 'application/json',
      body: JSON.stringify({
        recordingId: recording.id,
        actions: 8,
        skillId: saved.skill.id,
        originalRevision: 1,
        acceptedRevision: 2,
        rehearsalHasNoModelOrSiteEffects: true,
        firstRunId: first.runId,
        repairRunId: repaired.runId,
        newInputsConfirmed: true,
        submissions: 3,
        repairCalls: 1,
        patchId: patches[0]!.id,
        approvals: firstResult.approvals + repairedResult.approvals,
        recordedTextAbsent: true,
      }),
    });
  } finally {
    await model.close();
  }
});

test('Phase 9 production: accept style, vote on blind drafts and use the current style in a worker draft', async ({
  page,
  context,
}, info) => {
  test.setTimeout(180000);
  test.skip(!process.env.PLAYWRIGHT_SETUP_DATA_DIR, 'Requires the fresh production setup stack.');
  const { api, model, project, complete } = await prepare(
    context,
    info,
    'Phase 9 writing comparison',
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('/skills');
    const style = page.getByRole('region', { name: 'Writing style', exact: true });
    await style
      .getByLabel('Writing sample', { exact: true })
      .fill('Hi team, the review is ready. Please check the open questions before Friday. Thanks,');
    const previewResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/skills/style/preview') &&
        response.request().method() === 'POST',
    );
    await style.getByRole('button', { name: 'Generate style preview', exact: true }).click();
    const preview = styleProfileSchema.parse(await (await previewResponse).json());
    expect(preview.status).toBe('preview');
    const acceptedResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/api/skills/style/${preview.id}/accept`),
    );
    await style.getByRole('button', { name: 'Accept writing style', exact: true }).click();
    const accepted = skillVersionSchema.parse(await (await acceptedResponse).json());
    const comparison = style.getByRole('region', { name: 'Blind writing comparison', exact: true });
    await comparison.getByLabel('Comparison project').selectOption(project.id);
    await comparison
      .getByLabel('Drafting task')
      .fill(
        'Tell the team the project review is ready and ask them to check open questions before Friday.',
      );
    const comparedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/skills/style/comparisons' &&
        response.request().method() === 'POST',
    );
    await comparison.getByRole('button', { name: 'Compare drafts', exact: true }).click();
    const blind = styleComparisonSchema.parse(await (await comparedResponse).json());
    expect(blind).toMatchObject({ status: 'ready', vote: null, reveal: null, privateOnly: true });
    await expect(comparison.getByRole('region', { name: 'Draft A', exact: true })).toBeVisible();
    await expect(comparison.getByRole('region', { name: 'Draft B', exact: true })).toBeVisible();
    await expect(comparison.getByText(/used writing-style revision/)).toHaveCount(0);
    expect(
      (
        await api(
          'GET',
          `skills/style/comparisons?projectId=${project.id}`,
          z.array(styleComparisonSchema),
        )
      )[0]?.reveal,
    ).toBeNull();
    // A fixture vote verifies concealment and persistence, not a human style preference.
    await comparison.getByRole('radio', { name: 'Tie', exact: true }).check();
    await comparison
      .getByRole('button', { name: 'Save preference and reveal', exact: true })
      .click();
    await expect(
      comparison.getByRole('article', { name: 'Draft comparison' }).getByRole('status'),
    ).toContainText('You recorded a tie.');
    const voted = (
      await api(
        'GET',
        `skills/style/comparisons?projectId=${project.id}`,
        z.array(styleComparisonSchema),
      )
    )[0]!;
    expect(voted.reveal).toMatchObject({
      preference: 'tie',
      skillId: accepted.id,
      revision: accepted.revision,
    });
    expect(model.categories.filter((category) => category === 'comparison')).toHaveLength(2);
    const mission = await api('POST', 'missions', missionSchema, {
      projectId: project.id,
      requestId: randomUUID(),
      agent: 'comms',
      goal: 'Draft a project review note asking the team to check open questions before Friday.',
    });
    const result = await complete(mission.id);
    await waitForProductionExtractions(context.request, [mission.run.id]);
    expect(result.detail.mission.run.tainted).toBe(true);
    expect(result.detail.steps.some((step) => step.prompt?.includes(phaseNineStyleTrait))).toBe(
      true,
    );
    expect(model.categories).toContain('styled-agent');
    expect(model.failures).toEqual([]);
    expect(errors).toEqual([]);
    await comparison.screenshot({ path: info.outputPath('phase9-blind-comparison.png') });
    await info.attach('phase9-style-production-evidence', {
      contentType: 'application/json',
      body: JSON.stringify({
        profileId: preview.id,
        styleSkillId: accepted.id,
        revision: accepted.revision,
        comparisonId: voted.id,
        costUsd: voted.costUsd,
        assignmentHiddenUntilVote: true,
        vote: 'tie',
        voteIsSynthetic: true,
        humanPreferenceVerified: false,
        draftRunId: mission.run.id,
        currentStyleInPrompt: true,
        tainted: true,
      }),
    });
  } finally {
    await info.attach('phase9-style-model-diagnostics', {
      contentType: 'application/json',
      body: JSON.stringify({ categories: model.categories, failures: model.failures }),
    });
    await model.close();
  }
});

test('Phase 9 production: three completed CoS missions produce an editable inert skill proposal', async ({
  page,
  context,
}, info) => {
  test.setTimeout(240000);
  test.skip(!process.env.PLAYWRIGHT_SETUP_DATA_DIR, 'Requires the fresh production setup stack.');
  const { api, model, project, complete } = await prepare(
    context,
    info,
    'Phase 9 repeated mission review',
  );
  const missionIds: string[] = [],
    runIds: string[] = [],
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    for (const day of [4, 5, 6]) {
      const mission = await api('POST', 'missions', missionSchema, {
        projectId: project.id,
        requestId: randomUUID(),
        agent: 'cos',
        goal: `Prepare the weekly project review from the latest approved sources for 2026-11-${day}.`,
      });
      missionIds.push(mission.id);
      runIds.push(mission.run.id);
      const result = await complete(mission.id);
      expect(result.detail.graph?.tasks).toHaveLength(2);
      expect(result.detail.graph?.tasks.every((task) => task.status === 'completed')).toBe(true);
      await waitForProductionExtractions(context.request, [mission.run.id]);
      if (day < 6)
        expect(
          await api(
            'GET',
            `skills/proposals?projectId=${project.id}`,
            z.array(skillProposalSchema),
          ),
        ).toEqual([]);
    }
    const proposals = await api(
      'GET',
      `skills/proposals?projectId=${project.id}`,
      z.array(skillProposalSchema),
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ status: 'proposed', skillId: null, privateOnly: true });
    expect(proposals[0]!.sources.map((source) => source.missionId).sort()).toEqual(
      [...missionIds].sort(),
    );
    const before = model.requests.length;
    await page.goto('/skills');
    const panel = page.getByRole('region', { name: 'Skills proposed from missions' });
    await panel.getByLabel('Proposal project').selectOption(project.id);
    const proposal = panel.getByRole('article', { name: 'Mission skill proposal' });
    await expect(proposal.getByRole('link', { name: /Source mission/ })).toHaveCount(3);
    const editor = proposal.getByLabel('Proposed SKILL.md');
    const reviewedName = `phase-nine-review-${project.id.replaceAll('_', '-').toLowerCase()}`;
    const reviewedDraft = (await editor.inputValue()).replace(
      /^name:.*$/m,
      `name: ${reviewedName}`,
    );
    await editor.fill(
      `${reviewedDraft}\nOwner review: confirm the current evidence before applying these instructions.\n`,
    );
    await proposal.getByRole('button', { name: 'Accept reviewed skill', exact: true }).click();
    await expect(
      proposal.getByRole('button', { name: 'Open accepted skill', exact: true }),
    ).toBeVisible();
    const accepted = (
      await api('GET', `skills/proposals?projectId=${project.id}`, z.array(skillProposalSchema))
    )[0]!;
    const skill = await api('GET', `skills/${accepted.skillId}`, skillVersionSchema);
    expect(skill).toMatchObject({
      source: 'proposed',
      privateOnly: true,
      enabled: true,
      revision: 1,
    });
    expect(skill.markdown).toContain('Owner review: confirm the current evidence');
    expect(skill.markdown).toContain(`name: ${reviewedName}`);
    expect(skill.markdown).toContain('tools: []');
    expect(skill.markdown).toContain('permissions: []');
    expect(model.requests).toHaveLength(before);
    await proposal.getByRole('button', { name: 'Open accepted skill', exact: true }).click();
    await expect(
      page
        .getByRole('region', { name: 'Skill editor' })
        .getByRole('textbox', { name: 'SKILL.md', exact: true }),
    ).toHaveValue(skill.markdown);
    expect(model.failures).toEqual([]);
    expect(errors).toEqual([]);
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await panel.screenshot({ path: info.outputPath('phase9-mission-proposal-mobile.png') });
    await info.attach('phase9-proposals-production-evidence', {
      contentType: 'application/json',
      body: JSON.stringify({
        missionIds,
        runIds,
        proposalId: accepted.id,
        skillId: skill.id,
        sourceCount: 3,
        thresholdVerified: true,
        reviewedEditPreserved: true,
        privateOnly: true,
        proposalModelCalls: 0,
        noInferredToolPermissions: true,
      }),
    });
  } finally {
    await model.close();
  }
});
