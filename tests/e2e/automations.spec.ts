import { expect, test } from '@playwright/test';
import { fixtureId, mockDurableWorkspace, projectId, stamp } from './durable-fixture';

test('reviews a natural-language schedule, invalidates changed previews, and saves exact reviewed times', async ({
  page,
}) => {
  const state = await mockDurableWorkspace(page);
  await page.goto('/automations');
  await page.getByRole('button', { name: 'New automation', exact: true }).click();
  await page.getByLabel('Automation name').fill('Morning Brief');
  await page
    .getByLabel('Mission goal')
    .fill('Collect priorities and summarize them for the morning digest.');
  await expect(page.getByRole('button', { name: 'Save automation', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Preview schedule', exact: true }).click();
  const review = page.getByRole('region', { name: 'Schedule review' });
  await expect(review).toContainText('Every weekday at 09:00');
  await expect(review).toContainText('Asia/Kolkata');
  await expect(review).toContainText(/9:00\s*am/i);
  await page.getByLabel('I reviewed these times and the timezone').check();
  await page.getByLabel('Schedule timezone').fill('UTC');
  await expect(review).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save automation', exact: true })).toBeDisabled();
  await page.getByLabel('Schedule timezone').fill('Asia/Kolkata');
  await page.getByRole('button', { name: 'Preview schedule', exact: true }).click();
  await page.getByLabel('I reviewed these times and the timezone').check();
  await page.getByRole('button', { name: 'Save automation', exact: true }).click();
  const trigger = page
    .getByRole('article', { name: 'Morning Brief', exact: true })
    .filter({ has: page.getByRole('button', { name: 'Run once' }) });
  await expect(trigger).toBeVisible();
  expect(state.triggerInputs[0]).toMatchObject({
    name: 'Morning Brief',
    config: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Kolkata' },
    reviewToken: 'reviewed-schedule-token',
    enabled: true,
  });
  await trigger.getByRole('button', { name: 'Pause automation' }).click();
  await expect(trigger.getByRole('button', { name: 'Enable automation' })).toBeVisible();
  expect(state.triggerUpdates).toEqual([{ enabled: false, version: 1 }]);
  await trigger.getByRole('button', { name: 'Run once' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Mission queued' })).toBeVisible();
  expect(state.manualRuns).toBe(1);
});

test('creates RSS, IMAP, and signed webhook triggers using vault references', async ({ page }) => {
  const state = await mockDurableWorkspace(page);
  await page.goto('/automations');
  for (const kind of ['rss', 'imap', 'webhook']) {
    await page.getByRole('button', { name: 'New automation', exact: true }).click();
    await page.getByLabel('Automation name').fill(`${kind} updates`);
    await page.getByLabel('Mission goal').fill('Summarize the incoming update for my digest.');
    await page.getByLabel('Trigger type').selectOption(kind);
    if (kind === 'rss') await page.getByLabel('RSS feed URL').fill('https://example.com/feed.xml');
    if (kind === 'imap') {
      await expect(page.getByLabel('Email account')).toHaveValue('imap-work');
      await page.getByLabel('Mailbox', { exact: true }).fill('Updates');
    }
    if (kind === 'webhook')
      await page
        .getByLabel('Webhook signing credential')
        .selectOption(`secret://${fixtureId('sec')}`);
    await page.getByRole('button', { name: 'Save automation', exact: true }).click();
    await expect(page.getByRole('article', { name: `${kind} updates` })).toBeVisible();
  }
  expect(state.triggerInputs.map((item) => item.config)).toEqual([
    { kind: 'rss', url: 'https://example.com/feed.xml', pollIntervalSeconds: 300 },
    { kind: 'imap', connectorId: 'imap-work', mailbox: 'Updates', pollIntervalSeconds: 300 },
    { kind: 'webhook', secretRef: `secret://${fixtureId('sec')}` },
  ]);
  await expect(page.getByRole('article', { name: 'webhook updates' })).toContainText(
    `/hooks/${fixtureId('trg', '3')}`,
  );
  expect(state.previews).toHaveLength(0);
});

test('rejects a malformed schedule preview before enabling save', async ({ page }) => {
  const state = await mockDurableWorkspace(page, { malformedPreview: true });
  await page.goto('/automations');
  await page.getByRole('button', { name: 'New automation', exact: true }).click();
  await page.getByLabel('Automation name').fill('Morning Brief');
  await page.getByLabel('Mission goal').fill('Prepare a digest.');
  await page.getByRole('button', { name: 'Preview schedule', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'The server returned an invalid response.',
  );
  await expect(page.getByRole('button', { name: 'Save automation', exact: true })).toBeDisabled();
  expect(state.triggerInputs).toHaveLength(0);
});

test('pairs a Telegram project, observes the binding, and explicitly unpairs it', async ({
  page,
}) => {
  const state = await mockDurableWorkspace(page);
  await page.goto('/automations#telegram');
  const panel = page.getByRole('region', { name: 'Telegram pairing' });
  await panel.getByRole('button', { name: 'Generate pairing code', exact: true }).click();
  await expect(panel.getByText('/pair 482913', { exact: true })).toBeVisible();
  expect(state.pairInputs).toEqual([{ projectId }]);
  state.bindings.push({
    id: fixtureId('bnd'),
    senderId: '112233',
    chatId: '112233',
    projectId,
    createdAt: stamp,
  });
  await panel.getByRole('button', { name: 'Refresh pairing status' }).click();
  await expect(panel.getByRole('heading', { name: 'Paired accounts (1)' })).toBeVisible();
  await panel.getByRole('button', { name: 'Unpair account' }).click();
  expect(state.unpairs).toHaveLength(0);
  await panel.getByRole('button', { name: 'Confirm unpair' }).click();
  await expect(panel.getByRole('heading', { name: 'Paired accounts (0)' })).toBeVisible();
  expect(state.unpairs).toEqual([fixtureId('bnd')]);
});

test('shows quiet hours, digest contents, deferred delivery and uncertain delivery on mobile', async ({
  page,
}) => {
  const state = await mockDurableWorkspace(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/automations#notifications');
  const panel = page.getByRole('region', { name: 'Notifications and digests' });
  await expect(panel).toContainText('22:00–08:00');
  await expect(panel.getByRole('article', { name: 'Morning Brief' })).toContainText(
    'Two priorities remain.',
  );
  await panel.getByLabel('Activity view').selectOption('notifications');
  await expect(panel.getByRole('article', { name: 'Quiet-hour update' })).toContainText('Deferred');
  await expect(panel.getByRole('article', { name: 'Delivery needs verification' })).toContainText(
    'Check the destination before repeating this action.',
  );
  await expect(page.getByRole('button', { name: 'Pause all agents' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  expect(state.manualRuns).toBe(0);
});
