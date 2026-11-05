import { expect, test, type Page } from '@playwright/test';
import { z } from 'zod';
import { freshSettings, settingsSchemas } from '@sazuz/config/settings';
import { fixtureId, projectId } from './durable-fixture';

async function mockSettings(page: Page) {
  const settings = freshSettings();
  const updates: unknown[] = [];
  const oauthStarts: unknown[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/get-session')
      return route.fulfill({ json: { user: { id: 'browser-owner' } } });
    if (path === '/api/settings') return route.fulfill({ json: settings });
    if (path === '/api/vault/secrets')
      return route.fulfill({
        json: [
          {
            id: fixtureId('sec'),
            reference: `secret://${fixtureId('sec')}`,
            name: 'Google OAuth client secret',
            maskedValue: '••••',
            revision: 1,
          },
        ],
      });
    if (path === '/api/vault/status')
      return route.fulfill({
        json: { initialized: true, locked: false, mode: 'auto', recoveryConfirmed: true },
      });
    if (/^\/api\/settings\/[^/]+\/history$/.test(path)) return route.fulfill({ json: [] });
    if (path === '/api/settings/connectors' && request.method() === 'PUT') {
      const input = z
        .strictObject({ value: settingsSchemas.connectors, expectedVersion: z.number().int() })
        .parse(request.postDataJSON());
      updates.push(input);
      settings.connectors = { value: input.value, version: input.expectedVersion + 1 };
      return route.fulfill({ json: { version: settings.connectors.version } });
    }
    if (path === '/api/settings/security' && request.method() === 'PUT') {
      const input = z
        .strictObject({ value: settingsSchemas.security, expectedVersion: z.number().int() })
        .parse(request.postDataJSON());
      updates.push(input);
      settings.security = { value: input.value, version: input.expectedVersion + 1 };
      return route.fulfill({ json: { version: settings.security.version } });
    }
    if (path === '/api/connectors/work-google/oauth/google/start') {
      oauthStarts.push(z.strictObject({ version: z.number().int() }).parse(request.postDataJSON()));
      return route.fulfill({
        json: {
          authorizationUrl:
            'https://accounts.google.com/o/oauth2/v2/auth?state=browser-fixture-state',
          expiresAt: '2030-11-03T12:00:00.000Z',
        },
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND', message: 'No browser fixture.' } },
    });
  });
  return { settings, updates, oauthStarts };
}

test('configures optional Google OAuth fields without invalid empty connector options', async ({
  page,
}) => {
  const state = await mockSettings(page);
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      contentType: 'text/plain',
      body: 'Mocked Google authorization page. No external request was made.',
    }),
  );
  await page.goto('/settings?section=connectors');
  await page.getByRole('button', { name: 'Add accounts', exact: true }).click();
  await page.getByLabel('Id', { exact: true }).fill('work-google');
  await page.getByLabel('Name', { exact: true }).fill('Work Google mail');
  await page.getByRole('button', { name: 'Configure provider', exact: true }).click();
  await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('gmail');
  await page.getByRole('button', { name: 'Add scopes', exact: true }).click();
  await page.getByLabel('Scopes 1', { exact: true }).fill('email:read');
  await page.getByRole('button', { name: 'Configure oauth client id', exact: true }).click();
  await page
    .getByLabel('Oauth Client Id', { exact: true })
    .fill('browser-fixture.apps.googleusercontent.com');
  await page
    .getByRole('button', { name: 'Configure oauth client secret ref', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: /^Oauth Client Secret Ref/ })
    .selectOption(`secret://${fixtureId('sec')}`);
  await page.getByRole('button', { name: 'Configure oauth redirect uri', exact: true }).click();
  await page
    .getByLabel('Oauth Redirect Uri', { exact: true })
    .fill('http://127.0.0.1:7797/oauth/google/callback');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByText('Saved. Changes are applied to running services automatically.'),
  ).toBeVisible();
  expect(state.settings.connectors.value.accounts[0]).toMatchObject({
    id: 'work-google',
    provider: 'gmail',
    options: {
      oauthClientId: 'browser-fixture.apps.googleusercontent.com',
      oauthClientSecretRef: `secret://${fixtureId('sec')}`,
    },
  });
  expect(state.settings.connectors.value.accounts[0]!.options).not.toHaveProperty('imapHost');
  await page.getByRole('button', { name: 'Connect Google account', exact: true }).click();
  await expect(page).toHaveURL(
    'https://accounts.google.com/o/oauth2/v2/auth?state=browser-fixture-state',
  );
  expect(state.oauthStarts).toEqual([{ version: 1 }]);
});

test('edits an agent-scoped rule with an optional comparison value in Safety settings', async ({
  page,
}) => {
  const state = await mockSettings(page);
  await page.goto('/settings?section=security');
  await page.getByRole('button', { name: 'Add rules', exact: true }).click();
  const rule = page.getByRole('group', { name: 'Rules 1', exact: true });
  await rule.getByLabel('Id', { exact: true }).fill('review-recipient');
  await rule.getByRole('combobox', { name: 'Scope type', exact: true }).selectOption('agent');
  await rule.getByLabel('Agent Id', { exact: true }).fill('comms');
  await rule.getByRole('button', { name: 'Configure project id', exact: true }).click();
  await rule.getByLabel('Project Id', { exact: true }).fill(projectId);
  await rule.getByRole('button', { name: 'Configure tool', exact: true }).click();
  await rule.getByLabel('Tool', { exact: true }).fill('gmail.send');
  await rule.getByRole('button', { name: 'Add when', exact: true }).click();
  await rule.getByLabel('Field', { exact: true }).fill('args.to.0');
  await rule.getByRole('button', { name: 'Configure value', exact: true }).click();
  await rule.getByLabel('Value', { exact: true }).fill('reviewer@example.com');
  await rule.getByRole('combobox', { name: 'Action', exact: true }).selectOption('ask');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByText('Saved. Changes are applied to running services automatically.'),
  ).toBeVisible();
  expect(state.settings.security.value.rules[0]).toMatchObject({
    id: 'review-recipient',
    scope: { type: 'agent', agentId: 'comms', projectId },
    match: { tool: 'gmail.send' },
    when: [{ field: 'args.to.0', op: 'eq', value: 'reviewer@example.com' }],
    action: 'ask',
  });
});
