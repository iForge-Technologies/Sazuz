import { expect, test } from '@playwright/test';

// The public health screen exercises the actual shell without synthetic sessions.
test('page search supports keyboard selection, no results, Escape and focus return', async ({
  page,
}) => {
  await page.goto('/health');
  const trigger = page.getByRole('button', { name: 'Search pages', exact: true });
  await trigger.focus();
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Go to page', exact: true });
  const search = dialog.getByRole('combobox', { name: 'Find a page', exact: true });
  await expect(dialog).toBeVisible();
  await expect(search).toBeFocused();
  await expect(dialog.getByRole('option')).toHaveCount(18);
  await page.keyboard.press('Tab');
  await expect(
    dialog.getByRole('button', { name: 'Close page search', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(search).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const active = await search.getAttribute('aria-activedescendant');
  expect(active).toBeTruthy();
  await expect(dialog.locator(`[id="${active}"]`)).toHaveAttribute('aria-selected', 'true');
  await search.fill('this-page-does-not-exist');
  await expect(dialog.getByRole('option')).toHaveCount(0);
  await expect(dialog.getByRole('status')).toContainText('No pages match');
  await expect(search).not.toHaveAttribute('aria-activedescendant');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await search.fill('database');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/\/health$/);
});

for (const width of [320, 375]) {
  test(`navigation fits ${width}px and contains keyboard focus until dismissed`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/health');
    const trigger = page.getByRole('button', { name: 'Open navigation', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Workspace navigation', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'System health', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (let step = 0; step < 24; step++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
        true,
      );
    }
    for (let step = 0; step < 24; step++) {
      await page.keyboard.press('Shift+Tab');
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
        true,
      );
    }
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Go to page', exact: true })).not.toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await dialog.getByRole('link', { name: 'System health', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page).toHaveURL(/\/health$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await trigger.click();
    await page.screenshot({ path: info.outputPath(`navigation-${width}.png`) });
  });
}

test('reduced motion suppresses decorative transitions and preserves page search', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/health');
  await page.getByRole('button', { name: 'Search pages', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Go to page', exact: true });
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((element) =>
      element.getAnimations({ subtree: true }).some((animation) => {
        const timing = animation.effect?.getComputedTiming();
        return animation.playState === 'running' && Number(timing?.duration ?? 0) > 1;
      }),
    ),
  ).toBe(false);
  await dialog.getByRole('button', { name: 'Close page search', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});
