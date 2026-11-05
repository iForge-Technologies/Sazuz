import { expect, test } from '@playwright/test';
import { bridgeDeviceInputSchema, bridgeDeviceSchema, bridgeSaveSchema } from '@sazuz/core/bridge';
import { fixtureId, mockDurableWorkspace, projectId, stamp } from './durable-fixture';

test('pairs and reviews Bridge scope without returning a credential, then revokes on mobile', async ({
  page,
}) => {
  await mockDurableWorkspace(page);
  const devices: ReturnType<typeof bridgeDeviceSchema.parse>[] = [];
  await page.route('**/api/bridge/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === '/api/bridge/devices') {
      if (request.method() === 'POST') {
        const value = bridgeDeviceInputSchema.parse(request.postDataJSON());
        const device = bridgeDeviceSchema.parse({
          ...value,
          id: fixtureId('brg'),
          version: 1,
          enabled: true,
          online: true,
          lastSeenAt: stamp,
          offeredPin: 'a'.repeat(64),
          offered: {
            folders: [{ alias: 'notes', mode: 'read', delete: false }],
            commands: [],
            notifications: false,
            privateOnly: true,
          },
          grant: null,
        });
        devices.push(device);
        return route.fulfill({ json: device });
      }
      return route.fulfill({ json: devices });
    }
    const device = devices[0]!;
    if (request.method() === 'PUT') {
      const input = bridgeSaveSchema.parse(request.postDataJSON());
      device.grant = input.grant;
      device.version++;
      return route.fulfill({ json: device });
    }
    if (path.endsWith('/control')) {
      expect(request.method()).toBe('POST');
      expect(request.postDataJSON()).toEqual({ expectedVersion: device.version, enabled: false });
      device.enabled = false;
      device.online = false;
      device.version++;
      return route.fulfill({ json: device });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto('/connectors');
  const panel = page.getByRole('region', { name: 'Local Bridge', exact: true });
  await panel.getByText('Add Bridge device', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await panel.getByLabel('Bridge device name', { exact: true }).fill('My laptop');
  await panel
    .getByRole('combobox', { name: 'Bridge project', exact: true })
    .selectOption(projectId);
  await panel
    .getByRole('combobox', { name: 'Bridge vault credential', exact: true })
    .selectOption(`secret://${fixtureId('sec')}`);
  await panel.getByRole('button', { name: 'Create Bridge device', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'My laptop', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Review My laptop scopes', exact: true }).click();
  const review = panel.getByRole('form', { name: 'Bridge grant review', exact: true });
  await review.getByLabel('operator', { exact: true }).check();
  await expect(review.getByRole('combobox', { name: 'Mode for notes', exact: true })).toHaveValue(
    'read',
  );
  await expect(
    review.getByRole('combobox', { name: 'Mode for notes', exact: true }).getByRole('option'),
  ).toHaveCount(1);
  await review.getByRole('button', { name: 'Save reviewed Bridge grant', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Reviewed Bridge grant saved');
  expect(devices[0]!.grant!.agents).toEqual(['operator']);
  expect(devices[0]!.grant!.privateOnly).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole('button', { name: 'Revoke device', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Enable device', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(await panel.innerText()).not.toContain('secret://');
});
