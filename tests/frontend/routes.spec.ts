import { expect, test, type Page } from '@playwright/test';
import { namespaceSchema, settingsDocumentSchema } from '@sazuz/config/settings';
import { z } from 'zod';
import { ownerApi } from '../e2e/phase-eleven-helpers';
import { missionSchema } from '@sazuz/core/missions';
import { workflowSchema } from '@sazuz/core/workflows';
import { projectSchema } from '@sazuz/core/work';
import { chunkSchema, sourceSchema } from '@sazuz/core/knowledge';

const pages = [
  ['/chat', 'Chat', '/api/threads'],
  ['/missions', 'Missions', '/api/missions'],
  ['/approvals', 'Approvals', '/api/approvals'],
  ['/browser', 'Browser', '/api/browser/sessions'],
  ['/agents', 'Agents', '/api/agents'],
  ['/workflows', 'Workflows', '/api/workflows'],
  ['/automations', 'Automations', '/api/triggers'],
  ['/recipes', 'Recipes', '/api/recipes'],
  ['/knowledge', 'Knowledge', '/api/kb/sources'],
  ['/memory', 'Memory', '/api/memory'],
  ['/skills', 'Skills', '/api/skills'],
  ['/models', 'Models', '/api/models'],
  ['/connectors', 'Connectors', '/api/connectors/catalogue'],
  ['/costs', 'Costs', '/api/costs/dashboard'],
  ['/evals', 'Evaluations', '/api/evals'],
  ['/audit', 'Audit history', '/api/audit'],
  ['/health', 'System health', '/api/health'],
] as const;

async function openLoadedPage(page: Page, path: string, resourcePath: string) {
  const loaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === resourcePath && response.request().method() === 'GET',
  );
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  expect((await loaded).status(), `Primary data for ${path}`).toBe(200);
  await expect(page.getByRole('status').filter({ hasText: /^Loading/ })).toHaveCount(0);
}

async function verifyLayout(page: Page, width: number) {
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    'The whole document must not scroll sideways; wide diagrams need their own scroll area.',
  ).toBeLessThanOrEqual(width);
  const missingNames = await page.getByRole('main').evaluate((main) => {
    const controls = main.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >('input:not([type="hidden"]),select,textarea');
    return Array.from(controls)
      .filter((element) => element.getClientRects().length > 0)
      .filter(
        (element) =>
          !element.getAttribute('aria-label') &&
          !element.getAttribute('aria-labelledby') &&
          !element.labels?.length &&
          !element.getAttribute('title') &&
          !(
            element instanceof HTMLInputElement &&
            ['button', 'submit', 'reset'].includes(element.type)
          ),
      )
      .map((element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}`);
  });
  expect(missingNames, 'Visible form controls need programmatic labels.').toEqual([]);
}

for (const view of [
  { name: 'desktop-light', width: 1440, height: 1000, colorScheme: 'light' },
  { name: 'desktop-dark', width: 1440, height: 1000, colorScheme: 'dark' },
  { name: 'mobile-light', width: 375, height: 844, colorScheme: 'light' },
  { name: 'narrow-dark', width: 320, height: 844, colorScheme: 'dark' },
] as const) {
  test(`all workspace routes and Settings sections render accessibly in ${view.name}`, async ({
    page,
    context,
  }, info) => {
    test.setTimeout(240_000);
    await ownerApi(context, info);
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.emulateMedia({ colorScheme: view.colorScheme });
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.name));
    for (const [path, title, resource] of pages) {
      await test.step(path, async () => {
        await openLoadedPage(page, path, resource);
        await expect(
          page.getByRole('heading', { level: 1, name: title, exact: true }),
        ).toBeVisible();
        await verifyLayout(page, view.width);
        await page.screenshot({ path: info.outputPath(`${view.name}-${path.slice(1)}.png`) });
      });
    }
    for (const namespace of namespaceSchema.options) {
      await test.step(`settings/${namespace}`, async () => {
        if (view.width > 1000 || namespace === 'general') {
          await openLoadedPage(
            page,
            `/settings?section=${namespace}`,
            `/api/settings/${namespace}/history`,
          );
        } else {
          const loaded = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === `/api/settings/${namespace}/history` &&
              response.request().method() === 'GET',
          );
          await page.getByLabel('Settings section', { exact: true }).selectOption(namespace);
          expect((await loaded).status()).toBe(200);
          await expect(page).toHaveURL(new RegExp(`/settings\\?section=${namespace}$`));
        }
        if (view.width <= 1000)
          await expect(page.getByLabel('Settings section', { exact: true })).toHaveValue(namespace);
        await expect(
          page.getByRole('heading', { level: 2, name: new RegExp(`^${namespace}$`, 'i') }),
        ).toBeVisible();
        await expect(
          page.getByRole('heading', { level: 1, name: 'Settings Center', exact: true }),
        ).toBeVisible();
        await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible();
        await verifyLayout(page, view.width);
        await page.screenshot({ path: info.outputPath(`${view.name}-settings-${namespace}.png`) });
      });
    }
    expect(runtimeErrors).toEqual([]);
  });
}

test('Settings native inputs support keyboard editing, validation and version history', async ({
  page,
  context,
}, info) => {
  await ownerApi(context, info);
  await page.goto('/settings?section=general');
  const theme = page.getByRole('combobox', { name: 'Theme', exact: true });
  await expect(theme).toBeEnabled();
  await theme.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(theme).toHaveValue('light');
  const instanceName = page.getByLabel('Instance Name', { exact: true });
  await instanceName.fill('');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(instanceName).toBeFocused();
  expect(
    await instanceName.evaluate((element: HTMLInputElement) => element.validity.valueMissing),
  ).toBe(true);
  await page.reload();
  await expect(instanceName).not.toHaveValue('');
  const history = page.getByText(/Version history \(/);
  await history.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Restore version 1', exact: true })).toBeVisible();
  await page.goto('/settings?section=memory');
  const autoAccept = page.getByRole('checkbox', { name: 'Auto Accept', exact: true });
  const before = await autoAccept.isChecked();
  await autoAccept.focus();
  await page.keyboard.press('Space');
  if (before) await expect(autoAccept).not.toBeChecked();
  else await expect(autoAccept).toBeChecked();
  await page.reload();
  await expect(autoAccept).toBeChecked({ checked: before });
});

test('seeded agent, mission, replay, workflow and citation detail routes fit desktop and mobile', async ({
  page,
  context,
}, info) => {
  const api = await ownerApi(context, info);
  const missions = await api('GET', 'missions', z.array(missionSchema));
  const workflows = await api('GET', 'workflows', z.array(workflowSchema));
  const projects = await api('GET', 'projects', z.array(projectSchema));
  expect(
    missions.length,
    'Run the production e2e suite to seed real mission data first.',
  ).toBeGreaterThan(0);
  expect(
    workflows.length,
    'Run the production e2e suite to seed real workflows first.',
  ).toBeGreaterThan(0);
  let citation: z.infer<typeof chunkSchema> | undefined;
  for (const project of projects) {
    const sources = await api('GET', `kb/sources?projectId=${project.id}`, z.array(sourceSchema));
    for (const source of sources) {
      citation = (
        await api('GET', `kb/sources/${source.id}/chunks?offset=0`, z.array(chunkSchema))
      )[0];
      if (citation) break;
    }
    if (citation) break;
  }
  expect(citation, 'Run the production e2e suite to seed a source citation first.').toBeDefined();
  if (!citation || !missions[0] || !workflows[0])
    throw new Error('The disposable frontend fixture is incomplete.');
  const routes = [
    ['/agents/cos', '/api/agents/cos', 'agent'],
    [`/missions/${missions[0].id}`, `/api/missions/${missions[0].id}`, 'mission'],
    [`/runs/${missions[0].run.id}`, `/api/runs/${missions[0].run.id}/detail`, 'replay'],
    [`/workflows/${workflows[0].id}`, `/api/workflows/${workflows[0].id}`, 'workflow'],
    [`/knowledge/chunks/${citation.id}`, `/api/kb/chunks/${citation.id}`, 'citation'],
  ] as const;
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [path, resource, name] of routes) {
      await test.step(`${name}/${width}`, async () => {
        await openLoadedPage(page, path, resource);
        await verifyLayout(page, width);
        await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
        await page.screenshot({ path: info.outputPath(`${name}-${width}.png`) });
      });
    }
  }
});

test('saved appearance survives reload and System follows the operating system preference', async ({
  page,
  context,
}, info) => {
  const api = await ownerApi(context, info);
  const before = await api('GET', 'settings', settingsDocumentSchema);
  const root = page.locator('html');
  const background = () =>
    page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor);
  try {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/settings?section=general');
    const theme = page.getByRole('combobox', { name: 'Theme', exact: true });
    const save = page.getByRole('button', { name: 'Save changes', exact: true });
    await theme.selectOption('light');
    await save.click();
    await expect(root).toHaveAttribute('data-theme', 'light');
    const light = await background();
    await page.reload();
    await expect(root).toHaveAttribute('data-theme', 'light');
    expect(await background()).toBe(light);
    await page.emulateMedia({ colorScheme: 'light' });
    await theme.selectOption('dark');
    await save.click();
    await expect(root).toHaveAttribute('data-theme', 'dark');
    const dark = await background();
    expect(dark).not.toBe(light);
    await page.reload();
    await expect(root).toHaveAttribute('data-theme', 'dark');
    expect(await background()).toBe(dark);
    await theme.selectOption('system');
    await save.click();
    await expect(root).toHaveAttribute('data-theme', 'system');
    await expect.poll(background).toBe(light);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(background).toBe(dark);
  } finally {
    const current = await api('GET', 'settings', settingsDocumentSchema);
    await api('PUT', 'settings/general', z.unknown(), {
      expectedVersion: current.general.version,
      value: { ...current.general.value, theme: before.general.value.theme },
    });
    const restored = await api('GET', 'settings', settingsDocumentSchema);
    expect(restored.general.value.theme).toBe(before.general.value.theme);
  }
});
