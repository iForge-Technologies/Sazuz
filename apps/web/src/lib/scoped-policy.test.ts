import { describe, expect, it } from 'vitest';
import { approvalSchema } from '@sazuz/core/missions';
import { evaluatePolicy } from '../../../../packages/policy/src/evaluate';
import { suggestRecipientRule } from './scoped-policy';

const id = `apr_${'0'.repeat(26)}`;
const approval = approvalSchema.parse({
  id,
  runId: `run_${'0'.repeat(26)}`,
  missionId: `mis_${'0'.repeat(26)}`,
  projectId: `prj_${'0'.repeat(26)}`,
  agentId: 'comms',
  toolName: 'gmail.send',
  args: {
    accountId: 'work-mail',
    to: ['recipient@example.com'],
    cc: [],
    subject: 'Update',
    text: 'Ready',
  },
  effect: 'send',
  reason: 'Send update',
  risk: 'medium',
  ruleId: 'preset:balanced:send:external',
  tainted: false,
  kind: 'policy',
  status: 'pending',
  version: 1,
  expiresAt: '2030-01-01T00:00:00.000Z',
  createdAt: '2026-11-03T12:00:00.000Z',
  note: null,
});

describe('scoped recipient rule suggestions', () => {
  it('matches only the reviewed recipient list, account, agent and project', () => {
    const suggestion = suggestRecipientRule(approval, 'allow-reviewed-email');
    expect(suggestion).not.toBeNull();
    const input = {
      tool: 'gmail.send',
      effect: 'send',
      agentId: 'comms',
      projectId: approval.projectId,
      tainted: false,
      rules: [suggestion!.rule],
      args: approval.args,
    };
    expect(evaluatePolicy(input).matchedRuleIds).toContain('allow-reviewed-email');
    const args = { accountId: 'work-mail', to: ['recipient@example.com'], cc: [] };
    for (const changed of [
      { ...args, to: [...args.to, 'new@example.com'] },
      { ...args, cc: ['new@example.com'] },
      { ...args, bcc: ['new@example.com'] },
      { ...args, accountId: 'other-account' },
    ])
      expect(evaluatePolicy({ ...input, args: changed }).matchedRuleIds).not.toContain(
        'allow-reviewed-email',
      );
    for (const changed of [
      { agentId: 'coder' },
      { projectId: 'different-project' },
      { tainted: true },
    ])
      expect(evaluatePolicy({ ...input, ...changed }).matchedRuleIds).not.toContain(
        'allow-reviewed-email',
      );
    expect(evaluatePolicy(input).action).toBe('ask');
  });
  it('does not turn unsupported or uncertain actions into blanket permissions', () => {
    expect(suggestRecipientRule({ ...approval, kind: 'uncertain' }, 'rule')).toBeNull();
    expect(suggestRecipientRule({ ...approval, toolName: 'payments.send' }, 'rule')).toBeNull();
    expect(
      suggestRecipientRule({ ...approval, args: { accountId: 'work-mail', to: [] } }, 'rule'),
    ).toBeNull();
    expect(
      suggestRecipientRule(
        { ...approval, args: { accountId: 'work-mail', to: 'recipient@example.com' } },
        'rule',
      ),
    ).toBeNull();
  });
});
