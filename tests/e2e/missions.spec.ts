import { expect, test } from '@playwright/test';
import { fixtureApproval, missionId, mockDurableWorkspace, projectId } from './durable-fixture';

test('creates a mission with the same request ID after an ambiguous request failure', async ({
  page,
}) => {
  const state = await mockDurableWorkspace(page, { empty: true, failFirstMission: true });
  await page.goto('/missions');
  await page.getByLabel('Mission title (optional)').fill('Prepare the morning brief');
  await page
    .getByLabel('Mission goal')
    .fill('Review the calendar and summarize today’s priorities.');
  await page.getByLabel('Assign to').selectOption('cos');
  await page.getByRole('button', { name: 'Start mission', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Retry this request.');
  await page.getByRole('button', { name: 'Start mission', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/missions/${missionId}$`));
  await expect(page.getByRole('region', { name: 'Selected mission' })).toContainText(
    'Prepare the morning brief',
  );
  expect(state.missionInputs).toHaveLength(2);
  expect(state.missionInputs[0]!.requestId).toBe(state.missionInputs[1]!.requestId);
  expect(state.missionInputs[1]).toMatchObject({
    projectId,
    agent: 'cos',
    goal: 'Review the calendar and summarize today’s priorities.',
  });
});

test('shows durable steps and handoffs, extends a capped run, and obeys global pause', async ({
  page,
}) => {
  const state = await mockDurableWorkspace(page, { status: 'budget_exceeded' });
  await page.goto(`/missions/${missionId}`);
  await expect(page.getByRole('region', { name: 'Mission timeline' })).toContainText(
    'Research the current progress',
  );
  await page.getByText('Action details', { exact: true }).click();
  await expect(
    page.getByText('<untrusted>Release review is ready.</untrusted>', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Team activity' })).toContainText(
    'Chief of Staff → Comms',
  );
  await page.getByLabel('Additional budget (USD)').fill('0');
  await page.getByRole('button', { name: 'Extend allowance and continue' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Add a positive');
  expect(state.runInputs).toHaveLength(0);
  await page.getByLabel('Additional budget (USD)').fill('0.25');
  await page.getByLabel('Additional steps').fill('3');
  await page.getByLabel('Additional time (seconds)').fill('60');
  await page.getByRole('button', { name: 'Continue with +$0.25' }).click();
  await expect(page.getByRole('button', { name: 'Pause mission', exact: true })).toBeVisible();
  expect(state.runInputs[0]).toEqual({
    action: 'extend',
    version: 3,
    addCostUsd: 0.25,
    addSteps: 3,
    addWallTimeSeconds: 60,
  });
  await page.getByRole('button', { name: 'Pause mission', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume mission', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Pause all agents', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume mission', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Resume all agents', exact: true }).click();
  await page.getByRole('button', { name: 'Resume mission', exact: true }).click();
  expect(state.runInputs.map((item) => item.action)).toEqual(['extend', 'pause', 'resume']);
  expect(state.controls).toEqual([
    { paused: true, version: 5 },
    { paused: false, version: 6 },
  ]);
});

test('renders an email preview and submits edited arguments with the reviewed version', async ({
  page,
}) => {
  const state = await mockDurableWorkspace(page, { approval: { tainted: true } });
  await page.goto('/approvals');
  await expect(page.getByRole('region', { name: 'Action preview' })).toContainText(
    'reviewer@example.com',
  );
  await expect(
    page.getByText('Proposed after reading external content.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit & approve', exact: true }).click();
  await page.getByLabel('Subject', { exact: true }).fill('Revised weekly update');
  await page
    .getByRole('textbox', { name: 'Text', exact: true })
    .fill('The release needs one final review.');
  await page.getByLabel('Decision note').fill('Use the revised status.');
  await expect(page.getByRole('region', { name: 'Action preview' })).toContainText(
    'Revised weekly update',
  );
  await page.getByRole('button', { name: 'Approve edited action' }).click();
  await expect(page.getByRole('heading', { name: 'No pending approvals' })).toBeVisible();
  expect(state.decisions[0]).toMatchObject({
    action: 'edit_approve',
    version: 2,
    args: {
      subject: 'Revised weekly update',
      text: 'The release needs one final review.',
      to: ['reviewer@example.com'],
    },
    note: 'Use the revised status.',
  });
});

test('requires re-review for a changed approval and blocks expired requests', async ({ page }) => {
  const state = await mockDurableWorkspace(page);
  await page.goto('/approvals');
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  state.approvals[0] = fixtureApproval({
    version: 3,
    args: {
      accountId: 'work-mail',
      to: ['changed@example.com'],
      cc: [],
      subject: 'Changed destination',
      text: 'Review this version.',
    },
  });
  await page.getByRole('button', { name: 'Refresh approvals' }).click();
  await expect(page.getByText('This request changed while you were reviewing it.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Review latest version' }).click();
  await expect(page.getByRole('region', { name: 'Action preview' })).toContainText(
    'changed@example.com',
  );
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  expect(state.decisions[0]).toMatchObject({ action: 'approve', version: 3 });
  state.approvals[0] = fixtureApproval({ version: 4, expiresAt: '2000-01-01T00:00:00.000Z' });
  await page.reload();
  await expect(
    page.getByText('This approval has expired. Its action is unavailable.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  expect(state.decisions).toHaveLength(1);
});

test('uncertain outcomes require explicit verification instead of ordinary approval', async ({
  page,
}) => {
  const state = await mockDurableWorkspace(page, {
    approval: {
      kind: 'uncertain',
      risk: 'high',
      reason: 'The worker stopped before recording the send outcome.',
    },
  });
  await page.goto('/approvals');
  await expect(
    page.getByText('The previous attempt may already have happened.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit & approve', exact: true })).toHaveCount(0);
  await page.getByLabel('Verification note').fill('Checked the recipient mailbox and message ID.');
  await page.getByRole('button', { name: 'Confirm action completed', exact: true }).click();
  await expect(page.getByText('Outcome recorded as completed.')).toBeVisible();
  expect(state.decisions[0]).toEqual({
    action: 'confirm_done',
    version: 2,
    note: 'Checked the recipient mailbox and message ID.',
  });
});

test('saves a narrow allow suggestion while retaining existing policy and pending approval', async ({
  page,
}) => {
  const state = await mockDurableWorkspace(page);
  await page.goto('/approvals');
  await page.getByRole('button', { name: 'Always allow — review scoped rule' }).click();
  await expect(
    page.getByText('Saving this suggestion does not approve the current request.', {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save scoped rule', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Scoped rule saved');
  expect(state.settings.security.version).toBe(5);
  expect(state.settings.security.value.preset).toBe('balanced');
  expect(state.settings.security.value.rules).toHaveLength(2);
  expect(state.settings.security.value.rules[0]!.id).toBe('retain-existing-deny');
  expect(state.settings.security.value.rules[1]).toMatchObject({
    scope: { type: 'agent', agentId: 'comms', projectId },
    match: { tool: 'gmail.send', effect: 'send' },
    action: 'allow',
  });
  expect(state.settings.security.value.rules[1]!.when).toContainEqual({
    field: 'args.to.length',
    op: 'eq',
    value: 1,
  });
  expect(state.decisions).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
});
