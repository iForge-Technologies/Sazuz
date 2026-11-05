import { expect, test } from '@playwright/test';
import { freshSettings } from '@sazuz/config/settings';
import { connectorCatalogue } from '../../packages/connectors/src/index';
import { fixtureId, mockDurableWorkspace } from './durable-fixture';

test('reviews native capabilities and exact account scopes on desktop and mobile', async ({
  page,
}) => {
  await mockDurableWorkspace(page);
  const settings = freshSettings();
  settings.connectors.value.accounts = [
    {
      id: 'team-slack',
      name: 'Team channel',
      kind: 'chat',
      provider: 'slack',
      secretRef: `secret://${fixtureId('sec')}`,
      scopes: ['slack:read'],
      mode: 'read',
      options: { channelId: 'C012345' },
    },
  ];
  await page.route('**/api/settings', (route) => route.fulfill({ json: settings }));
  await page.route('**/api/connectors/catalogue', (route) =>
    route.fulfill({ json: connectorCatalogue() }),
  );
  await page.goto('/connectors');
  await expect(page.getByRole('heading', { name: 'Connectors', exact: true })).toBeVisible();
  const account = page.getByText('Team channel · slack · read', { exact: true });
  await account.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Scopes: slack:read', { exact: true })).toBeVisible();
  await expect(page.getByText('C012345', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Grant exact account permissions in Agents' }),
  ).toHaveAttribute('href', '/agents');
  await page.getByText('Stripe (read-only) · 2 operations', { exact: true }).click();
  await expect(page.getByText('stripe.balance', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('link', { name: 'Configure accounts', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(await page.locator('body').innerText()).not.toContain('secret://');
});
