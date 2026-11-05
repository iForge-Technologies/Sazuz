import { describe, expect, it } from 'vitest';
import { evaluatePolicy, PolicyError, policyRuleSchema, type PolicyRequest } from './index.js';

const base: PolicyRequest = {
  tool: 'files.read',
  effect: 'read',
  scope: 'internal',
  projectId: 'project-a',
  agentId: 'researcher',
  tainted: false,
};
const evaluate = (request: Partial<PolicyRequest> = {}) => evaluatePolicy({ ...base, ...request });

describe('policy presets and safety floors', () => {
  it('enforces recipe effect limits and approval points even under permissive configured rules', () => {
    const permissive = {
      preset: 'autonomous' as const,
      knownRecipient: true,
      rules: [policyRuleSchema.parse({ id: 'permissive', action: 'allow' })],
    };
    for (const effect of ['write', 'send', 'delete', 'publish', 'spend', 'unknown'])
      expect(evaluate({ ...permissive, effect, allowedEffects: ['read'] })).toMatchObject({
        action: 'deny',
        ruleId: 'recipe:effect-limit',
      });
    expect(
      evaluate({ ...permissive, effect: 'read', effectKnown: false, allowedEffects: ['read'] })
        .action,
    ).toBe('deny');
    expect(
      evaluate({
        ...permissive,
        effect: 'send',
        allowedEffects: ['read', 'send'],
        askEffects: ['send'],
      }),
    ).toMatchObject({ action: 'ask', ruleId: 'recipe:approval' });
    expect(evaluate({ ...permissive, effect: 'read', allowedEffects: ['read'] }).action).toBe(
      'allow',
    );
    expect(
      evaluate({ ...permissive, effect: 'read', allowedEffects: ['read'], paused: true }).action,
    ).toBe('deny');
  });
  it.each([
    ['cautious', 'read', 'internal', 'allow'],
    ['cautious', 'write', 'internal', 'ask'],
    ['cautious', 'write', 'external', 'ask'],
    ['cautious', 'send', 'external', 'ask'],
    ['cautious', 'publish', 'external', 'deny'],
    ['cautious', 'delete', 'external', 'deny'],
    ['cautious', 'spend', 'external', 'deny'],
    ['balanced', 'read', 'internal', 'allow'],
    ['balanced', 'write', 'internal', 'allow'],
    ['balanced', 'write', 'external', 'ask'],
    ['balanced', 'send', 'external', 'ask'],
    ['balanced', 'publish', 'external', 'ask'],
    ['balanced', 'delete', 'external', 'ask'],
    ['balanced', 'spend', 'external', 'deny'],
    ['autonomous', 'read', 'internal', 'allow'],
    ['autonomous', 'write', 'internal', 'allow'],
    ['autonomous', 'write', 'external', 'allow'],
    ['autonomous', 'send', 'external', 'ask'],
    ['autonomous', 'publish', 'external', 'ask'],
    ['autonomous', 'delete', 'external', 'ask'],
    ['autonomous', 'spend', 'external', 'ask'],
  ] as const)('%s treats %s/%s as %s', (preset, effect, scope, expected) => {
    expect(evaluate({ preset, effect, scope }).action).toBe(expected);
  });

  it('only autonomously sends to a trusted known recipient before taint', () => {
    expect(evaluate({ preset: 'autonomous', effect: 'send', knownRecipient: true }).action).toBe(
      'allow',
    );
    expect(
      evaluate({ preset: 'autonomous', effect: 'send', knownRecipient: true, tainted: true }),
    ).toMatchObject({ action: 'ask', ruleId: 'safety:tainted' });
  });

  it.each([undefined, 'execute', 'READ'])(
    'normalizes unknown effect %s to a write requiring approval',
    (effect) => {
      const request = { ...base, effect, effectKnown: false, preset: 'autonomous' };
      expect(evaluatePolicy(request as PolicyRequest)).toMatchObject({
        action: 'ask',
        effect: 'write',
        ruleId: 'safety:unknown-effect',
      });
    },
  );

  it('does not trust an effectKnown claim for an unknown effect', () => {
    expect(evaluate({ effect: 'execute', effectKnown: true, preset: 'autonomous' }).action).toBe(
      'ask',
    );
  });

  it('escalates external writes after untrusted content while keeping internal files available', () => {
    expect(
      evaluate({ effect: 'write', scope: 'external', preset: 'autonomous', tainted: true }),
    ).toMatchObject({ action: 'ask', ruleId: 'safety:tainted' });
    expect(
      evaluate({ effect: 'write', scope: 'internal', preset: 'autonomous', tainted: true }).action,
    ).toBe('allow');
  });

  it.each(['cautious', 'balanced', 'autonomous'] as const)(
    'denies money movement under %s',
    (preset) => {
      const rule = policyRuleSchema.parse({
        id: 'allow-transfer',
        action: 'allow',
        match: { tool: 'custom.transfer' },
      });
      expect(
        evaluate({
          preset,
          tool: 'custom.transfer',
          effect: 'spend',
          moneyMovement: true,
          rules: [rule],
        }),
      ).toMatchObject({ action: 'deny', ruleId: 'safety:money-movement' });
      expect(evaluate({ preset, tool: 'payments.transfer', effect: 'read' }).action).toBe('deny');
    },
  );

  it('enforces kill switch and each exhausted run budget even for allowed reads', () => {
    expect(evaluate({ paused: true })).toMatchObject({ action: 'deny', ruleId: 'safety:paused' });
    for (const budget of [
      { remainingSteps: 0, remainingMs: 100, remainingUsd: 1 },
      { remainingSteps: 1, remainingMs: 0, remainingUsd: 1 },
      { remainingSteps: 1, remainingMs: 100, remainingUsd: 0.01, estimatedCostUsd: 0.02 },
    ])
      expect(evaluate({ budget })).toMatchObject({ action: 'deny', ruleId: 'safety:budget' });
  });
});

describe('declarative scoped rules', () => {
  it('keeps deny above ask and allow regardless of specificity or array order', () => {
    const rules = [
      policyRuleSchema.parse({
        id: 'agent-allow',
        scope: { type: 'agent', agentId: 'researcher' },
        action: 'allow',
        match: { tool: 'files.read' },
      }),
      policyRuleSchema.parse({
        id: 'project-ask',
        scope: { type: 'project', projectId: 'project-a' },
        action: 'ask',
      }),
      policyRuleSchema.parse({ id: 'global-deny', action: 'deny', match: { tool: 'files.*' } }),
    ];
    for (const ordered of [rules, [...rules].reverse()]) {
      expect(evaluate({ rules: ordered })).toMatchObject({ action: 'deny', ruleId: 'global-deny' });
    }
  });

  it('selects the most specific same-action match and does not cross project/agent scopes', () => {
    const rules = [
      policyRuleSchema.parse({ id: 'global-ask', action: 'ask' }),
      policyRuleSchema.parse({
        id: 'agent-ask',
        action: 'ask',
        scope: { type: 'agent', agentId: 'researcher', projectId: 'project-a' },
      }),
      policyRuleSchema.parse({
        id: 'other-project-deny',
        action: 'deny',
        scope: { type: 'project', projectId: 'project-b' },
      }),
      policyRuleSchema.parse({
        id: 'other-agent-deny',
        action: 'deny',
        scope: { type: 'agent', agentId: 'comms' },
      }),
    ];
    expect(evaluate({ rules })).toMatchObject({ action: 'ask', ruleId: 'agent-ask' });
    expect(evaluate({ rules, projectId: 'project-c' })).toMatchObject({
      action: 'ask',
      ruleId: 'global-ask',
    });
  });

  it('retains the preset decision as a floor, even for a narrowly scoped allow', () => {
    const rule = policyRuleSchema.parse({
      id: 'allow-send',
      action: 'allow',
      match: { tool: 'gmail.send' },
    });
    expect(evaluate({ tool: 'gmail.send', effect: 'send', rules: [rule] }).action).toBe('ask');
  });

  it('matches structured argument, connector and effect conditions without expression evaluation', () => {
    const rule = policyRuleSchema.parse({
      id: 'company-mail',
      action: 'deny',
      match: { tool: 'gmail.*', connector: 'gmail', effect: ['write', 'send'], scope: 'external' },
      when: [
        { field: 'args.to', op: 'allEndsWith', value: '@example.com' },
        { field: 'args.priority', op: 'gte', value: 2 },
      ],
    });
    const request: Partial<PolicyRequest> = {
      tool: 'gmail.send',
      connector: 'gmail',
      effect: 'send',
      scope: 'external',
      rules: [rule],
      args: { to: ['person@example.com'], priority: 2 },
    };
    expect(evaluate(request).action).toBe('deny');
    expect(evaluate({ ...request, args: { to: ['person@another.com'], priority: 2 } }).action).toBe(
      'ask',
    );
    expect(evaluate({ ...request, connector: 'imap' }).action).toBe('ask');
    expect(evaluate({ ...request, args: { to: [], priority: 2 } }).action).toBe('ask');
  });

  it('requires trusted counters for rate-limited allows and checks UTC windows', () => {
    const rule = policyRuleSchema.parse({
      id: 'limited',
      action: 'allow',
      limits: { perHour: 2, perRun: 3 },
      timeWindow: { startHourUtc: 9, endHourUtc: 17, weekdaysUtc: [1] },
    });
    const now = new Date('2026-11-02T12:00:00Z');
    expect(evaluate({ rules: [rule], now }).action).toBe('ask');
    expect(evaluate({ rules: [rule], now, usage: { limited: { hour: 1, run: 1 } } }).action).toBe(
      'allow',
    );
    expect(evaluate({ rules: [rule], now, usage: { limited: { hour: 2, run: 1 } } }).ruleId).toBe(
      'limited:limit',
    );
    expect(
      evaluate({
        rules: [rule],
        now: new Date('2026-11-02T17:00:00Z'),
        usage: { limited: { hour: 1, run: 1 } },
      }).action,
    ).toBe('ask');
    expect(
      evaluate({
        rules: [rule],
        now: new Date('2026-11-03T12:00:00Z'),
        usage: { limited: { hour: 1, run: 1 } },
      }).action,
    ).toBe('ask');
  });

  it('rejects code-like rules and prototype paths without exposing the invalid text', () => {
    expect(() =>
      evaluate({
        rules: [{ id: 'unsafe', action: 'allow', when: 'args.to.every(eval)' } as never],
      }),
    ).toThrow(PolicyError);
    expect(
      policyRuleSchema.safeParse({
        id: 'unsafe',
        action: 'allow',
        when: [{ field: 'args.__proto__.allow', op: 'eq', value: true }],
      }).success,
    ).toBe(false);
    const args = Object.create({ allowed: true }) as unknown;
    const rule = policyRuleSchema.parse({
      id: 'own-only',
      action: 'deny',
      when: [{ field: 'args.allowed', op: 'eq', value: true }],
    });
    expect(evaluate({ args, rules: [rule] }).action).toBe('allow');
  });
});
