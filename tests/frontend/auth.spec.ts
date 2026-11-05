import { expect, test } from '@playwright/test';
import { z } from 'zod';

test('sign-in validates fields, presents the authenticator challenge, and completes it', async ({
  page,
}, info) => {
  let signIns = 0;
  let verifications = 0;
  // Only authentication responses are fixtures; the actual login UI and native validation run.
  await page.route('**/api/auth/sign-in/email', async (route) => {
    const credentials = z
      .object({ email: z.email(), password: z.string() })
      .parse(route.request().postDataJSON());
    expect(credentials.email).toBe('ui-owner@example.test');
    signIns++;
    await route.fulfill({ json: { ok: true, twoFactorRedirect: true } });
  });
  await page.route('**/api/auth/two-factor/verify-totp', async (route) => {
    const input = z
      .object({ code: z.string().regex(/^\d{6}$/) })
      .parse(route.request().postDataJSON());
    expect(input.code).toBe('123456');
    verifications++;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/settings', async (route) => {
    await route.fulfill({ contentType: 'text/html', body: '<main><h1>Signed in</h1></main>' });
  });
  await page.goto('/login');
  const email = page.getByRole('textbox', { name: 'Email', exact: true });
  const password = page.getByLabel('Password', { exact: true });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(email).toBeFocused();
  expect(signIns).toBe(0);
  await email.fill('ui-owner@example.test');
  await password.fill('synthetic-auth-fixture');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const code = page.getByRole('textbox', { name: 'Authenticator code', exact: true });
  await expect(code).toBeFocused();
  await expect(password).not.toBeVisible();
  await code.fill('12');
  await page.getByRole('button', { name: 'Verify and sign in', exact: true }).click();
  expect(verifications).toBe(0);
  expect(await code.evaluate((element: HTMLInputElement) => element.validity.patternMismatch)).toBe(
    true,
  );
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: info.outputPath('authenticator-320.png') });
  await code.fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible();
  expect(signIns).toBe(1);
  expect(verifications).toBe(1);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`login is readable at desktop and mobile widths in ${colorScheme}`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: 'Welcome back', exact: true })).toBeVisible();
      await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await page.screenshot({ path: info.outputPath(`login-${colorScheme}-${width}.png`) });
    }
  });
}
