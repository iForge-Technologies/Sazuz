import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { z } from 'zod';
import { settingsDocumentSchema } from '@sazuz/config/settings';
import { backupStatusSchema, operationSchema } from '@sazuz/core/operations';
import { ownerApi } from './phase-eleven-helpers';

test('Phase 11: restore an encrypted snapshot through a separate fresh wizard and sign in after restart', async ({
  page,
  context,
}, info) => {
  test.setTimeout(240000);
  const targetUrl = process.env.PLAYWRIGHT_RESTORE_BASE_URL,
    targetData = process.env.PLAYWRIGHT_RESTORE_DATA_DIR;
  test.skip(
    !targetUrl || !targetData,
    'Provide a separate disposable core with automatic service restart and its private setup-token directory.',
  );
  if (!targetUrl || !targetData) return;
  const target = z.url().parse(targetUrl);
  expect(new URL(target).origin).not.toBe(
    new URL(z.string().parse(info.project.use.baseURL)).origin,
  );
  const api = await ownerApi(context, info);
  const source = await api('GET', 'settings', settingsDocumentSchema);
  const items = z.array(z.object({ id: z.string(), name: z.string() }));
  const projects = await api('GET', 'projects', items),
    secrets = await api('GET', 'vault/secrets', items);
  const created = await api('POST', 'backups', operationSchema, { requestId: crypto.randomUUID() });
  expect(created.status).toBe('done');
  const inventory = await api('GET', 'backups', backupStatusSchema);
  const backup = inventory.backups.find((item) => item.operationId === created.id)!;
  expect(backup).toBeTruthy();
  const download = await context.request.get(`/api/backups/${backup.id}/download`);
  expect(download.status()).toBe(200);
  const ciphertext = await download.body();
  await context.clearCookies();
  await page.goto(`${target}/setup`);
  await expect(page.getByRole('heading', { name: 'Enter your setup token' })).toBeVisible();
  const token = (await readFile(`${targetData}/secrets/setup-token`, 'utf8')).trim();
  await page.getByLabel('Setup token', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Unlock setup' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Sazuz' })).toBeVisible();
  await page.getByText('Restore from backup', { exact: true }).click();
  await page.getByLabel('Encrypted backup file').setInputFiles({
    name: 'phase11-browser.sazuz',
    mimeType: 'application/octet-stream',
    buffer: ciphertext,
  });
  await page.getByLabel('Vault passphrase or recovery key').fill('Browser-vault-passphrase-9251');
  await page.getByRole('button', { name: 'Restore this fresh installation' }).click();
  await expect(page.getByText(/Restore completed. Sazuz is restarting/)).toBeVisible({
    timeout: 150000,
  });
  await expect(page.getByLabel('Vault passphrase or recovery key')).toHaveValue('');
  const storage = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  expect(storage).not.toContain('Browser-vault-passphrase');
  expect(storage).not.toContain(token);
  await page.screenshot({ path: info.outputPath('phase11-wizard-restore.png'), fullPage: true });
  await expect
    .poll(
      async () => {
        try {
          return (await context.request.get(`${target}/api/health`)).status();
        } catch {
          return 0;
        }
      },
      { timeout: 120000, intervals: [500, 1000, 2000] },
    )
    .toBe(200);
  const restoredApi = await ownerApi(context, info, target);
  const restored = await restoredApi('GET', 'settings', settingsDocumentSchema);
  expect(restored.general.value.instanceName).toBe(source.general.value.instanceName);
  expect(new URL(restored.general.value.baseUrl).port).toBe(new URL(target).port);
  expect(await restoredApi('GET', 'projects', items)).toEqual(projects);
  expect(await restoredApi('GET', 'vault/secrets', items)).toEqual(secrets);
  expect(await restoredApi('GET', 'control', z.object({ paused: z.boolean() }))).toMatchObject({
    paused: true,
  });
  expect(restored.channels.value.webPush).toBe(false);
  await page.goto(`${target}/settings`);
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  await expect(page.getByLabel('Instance Name', { exact: true })).toHaveValue(
    source.general.value.instanceName,
  );
  await page.screenshot({ path: info.outputPath('phase11-restored-settings.png'), fullPage: true });
  await info.attach('phase11-wizard-restore-evidence', {
    contentType: 'application/json',
    body: JSON.stringify({
      separateFreshInstance: true,
      realPostgresDump: true,
      encryptedBytes: ciphertext.length,
      projects: projects.length,
      secretMetadata: secrets.length,
      settingsRestored: true,
      ownerSignIn: true,
      executionPaused: true,
    }),
  });
});
