import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

test('token gate, recovery download, wizard resume, settings history and completion', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120_000);
  const dataDir = process.env.PLAYWRIGHT_SETUP_DATA_DIR;
  test.skip(
    !dataDir,
    'Run on a fresh dedicated Phase 1 instance with PLAYWRIGHT_SETUP_DATA_DIR pointing to its private data directory.',
  );
  if (!dataDir) return;
  await expect
    .poll(
      async () => {
        try {
          return (await context.request.get('/api/health')).status();
        } catch {
          return 0;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(200);
  const token = (await readFile(`${dataDir}/secrets/setup-token`, 'utf8')).trim();
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Enter your setup token' })).toBeVisible();
  await page.getByLabel('Setup token', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Unlock setup' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Sazuz' })).toBeVisible();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByLabel('Your name').fill('Browser Owner');
  await page.getByLabel('Email', { exact: true }).fill('browser-owner@example.test');
  await page.getByLabel(/^Password/).fill('Browser-admin-password-7814');
  await page.getByRole('button', { name: 'Create admin account' }).click();
  await expect(page.getByRole('heading', { name: 'Protect your credentials' })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByText('Your admin account is ready.')).toBeVisible();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByLabel('Vault passphrase', { exact: true }).fill('Browser-vault-passphrase-9251');
  await page.getByRole('button', { name: 'Create vault', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save your recovery kit' })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download recovery kit' }).click();
  const download = await downloadPromise;
  const kit = await readFile(await download.path(), 'utf8');
  const key = z.string().parse(kit.match(/sazuz-recovery-v1:[A-Za-z0-9_-]+/)?.[0]);
  await page.getByLabel('Last four characters of the recovery key').fill(key.slice(-4));
  await page.getByRole('button', { name: 'Confirm recovery kit saved' }).click();
  await expect(page.getByRole('button', { name: 'Save and continue' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { name: 'AI providers', exact: true })).toBeVisible();
  await page.getByText('Vault credentials (0)', { exact: true }).click();
  await page.getByLabel('Credential name').fill('Browser test credential');
  await page.getByLabel('Secret value').fill('sk-browser-canary-186472951830');
  await page.getByRole('button', { name: 'Save credential in vault' }).click();
  await expect(page.getByText('Credential encrypted and saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Add items', exact: true }).click();
  await page.getByLabel('Id', { exact: true }).fill('local');
  await page.getByLabel('Name', { exact: true }).fill('Local Ollama');
  await page.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('ollama');
  await page.getByLabel('Base Url', { exact: true }).fill('http://localhost:11434');
  await page.getByRole('combobox', { name: 'Locality', exact: true }).selectOption('local');
  await page.getByLabel('Enabled', { exact: true }).check();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Models and router', exact: true })).toBeVisible();
  const reopened = await context.newPage();
  await page.close();
  await reopened.goto('/setup');
  await expect(
    reopened.getByRole('heading', { name: 'Models and router', exact: true }),
  ).toBeVisible();
  const browserStorage = await reopened.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  expect(JSON.stringify(browserStorage)).not.toContain('sk-browser-canary');
  expect(JSON.stringify(browserStorage)).not.toContain('Browser-vault');
  for (let step = 5; step <= 11; step++)
    await reopened.getByRole('button', { name: 'Skip for now' }).click();
  await expect(reopened.getByRole('heading', { name: 'Review and launch' })).toBeVisible();
  await reopened.screenshot({ path: testInfo.outputPath('wizard-review.png'), fullPage: true });
  await reopened.getByRole('button', { name: 'Launch Sazuz', exact: true }).click();
  await expect(reopened.getByRole('link', { name: 'Open Settings Center' })).toBeVisible();
  const disabledSetup = await context.request.get('/setup');
  expect(disabledSetup.status()).toBe(404);
  await reopened.goto('/settings');
  await expect(reopened.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  await reopened.getByLabel('Instance Name', { exact: true }).fill('Browser Verified Workspace');
  await reopened.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    reopened.getByText('Saved. Changes are applied to running services automatically.'),
  ).toBeVisible();
  await reopened.reload();
  await expect(reopened.getByLabel('Instance Name', { exact: true })).toHaveValue(
    'Browser Verified Workspace',
  );
  await reopened.getByText(/Version history \(/).click();
  await reopened.getByRole('button', { name: 'Restore version 1', exact: true }).click();
  await expect(reopened.getByLabel('Instance Name', { exact: true })).toHaveValue('Sazuz');
  await reopened.setViewportSize({ width: 390, height: 844 });
  await expect(reopened.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible();
  expect(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await reopened.screenshot({ path: testInfo.outputPath('settings-mobile.png'), fullPage: true });
});
