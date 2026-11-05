import { expect, test } from '@playwright/test';
import { approvalId, fixtureApproval, fixtureId, mockDurableWorkspace } from './durable-fixture';

test('reviews each similar action and approves frozen versions while excluding uncertain outcomes', async ({
  page,
}) => {
  const state = await mockDurableWorkspace(page);
  state.approvals.push(
    fixtureApproval({
      id: fixtureId('apr', '2'),
      version: 7,
      args: {
        accountId: 'work-mail',
        to: ['second@example.com'],
        cc: [],
        subject: 'Second weekly update',
        text: 'The second release is ready.',
      },
    }),
    fixtureApproval({ id: fixtureId('apr', '3'), kind: 'uncertain' }),
  );
  await page.goto('/approvals');
  const batch = page.getByRole('region', { name: 'Batch approvals' });
  await batch.getByRole('button', { name: 'Review 2 gmail.send requests' }).click();
  await expect(batch.getByRole('article')).toHaveCount(2);
  await expect(batch.getByRole('article', { name: 'Batch request 1' })).toContainText(
    'reviewer@example.com',
  );
  await expect(batch.getByRole('article', { name: 'Batch request 2' })).toContainText(
    'second@example.com',
  );
  await expect(batch.getByRole('article', { name: 'Batch request 2' })).toContainText(
    'Second weekly update',
  );
  await expect(batch.getByRole('article', { name: 'Batch request 2' })).toContainText(
    'The second release is ready.',
  );
  await expect(batch.getByRole('button', { name: 'Approve 2 reviewed requests' })).toBeDisabled();
  await batch.getByRole('textbox', { name: 'Batch decision note' }).fill('Both updates checked.');
  await batch.getByLabel('I reviewed all 2 requests').check();
  await batch.getByRole('button', { name: 'Approve 2 reviewed requests' }).click();
  await expect(batch.getByText('2 of 2 requests approved.', { exact: false })).toBeVisible();
  expect(state.decisionIds).toEqual([approvalId, fixtureId('apr', '2')]);
  expect(state.decisions).toEqual([
    { action: 'approve', version: 2, note: 'Both updates checked.' },
    { action: 'approve', version: 7, note: 'Both updates checked.' },
  ]);
  expect(state.approvals[2]!.status).toBe('pending');
  await expect(page.getByRole('button', { name: 'Confirm action completed' })).toBeVisible();
});

test('stops a batch on a conflict, reports partial success, and never retries changed versions', async ({
  page,
}) => {
  const state = await mockDurableWorkspace(page);
  state.approvals.push(
    fixtureApproval({ id: fixtureId('apr', '2'), version: 7 }),
    fixtureApproval({ id: fixtureId('apr', '3'), version: 9 }),
  );
  state.conflictingDecisionId = fixtureId('apr', '2');
  await page.goto('/approvals');
  const batch = page.getByRole('region', { name: 'Batch approvals' });
  await batch.getByRole('button', { name: 'Review 3 gmail.send requests' }).click();
  await batch.getByLabel('I reviewed all 3 requests').check();
  await batch.getByRole('button', { name: 'Approve 3 reviewed requests' }).click();
  await expect(batch.getByText('1 of 3 requests approved.', { exact: false })).toBeVisible();
  await expect(batch.getByRole('article', { name: 'Batch request 2' })).toContainText(
    'This item changed while you were reviewing it.',
  );
  await expect(batch.getByRole('article', { name: 'Batch request 3' })).toContainText(
    'Not attempted. Review this request separately.',
  );
  await expect(batch.getByRole('button', { name: 'Approve 3 reviewed requests' })).toHaveCount(0);
  expect(state.decisionIds).toEqual([approvalId, fixtureId('apr', '2')]);
  expect(state.decisions.map((item) => item.version)).toEqual([2, 7]);
  expect(state.approvals[0]!.status).toBe('approved');
  expect(state.approvals[1]!.version).toBe(8);
  expect(state.approvals[2]!.status).toBe('pending');
  await batch.getByRole('button', { name: 'Close batch review' }).click();
  await page.getByRole('button', { name: 'Review latest version' }).click();
  await expect(page.getByText('Changed after review', { exact: true })).toBeVisible();
});
