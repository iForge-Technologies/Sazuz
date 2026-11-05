import {
  normalizeEffect,
  policyRequestSchema,
  type PolicyCondition,
  type PolicyDecision,
  type PolicyPreset,
  type PolicyRequest,
  type PolicyRule,
  type ToolEffect,
} from './contracts';

type ParsedRequest = ReturnType<typeof policyRequestSchema.parse>;
type Candidate = Pick<PolicyDecision, 'action' | 'reason' | 'ruleId'> & { specificity: number };
const precedence = { allow: 0, ask: 1, deny: 2 } as const;

export class PolicyError extends Error {
  readonly code = 'INVALID_POLICY';

  constructor() {
    super('The policy request or rule is invalid.');
    this.name = 'PolicyError';
  }
}

function readField(request: ParsedRequest, field: string): unknown {
  if (field === 'run.tainted') return request.tainted;
  if (field === 'recipient.known') return request.knownRecipient;
  let value = request.args;
  for (const part of field.split('.').slice(1)) {
    if (value === null || typeof value !== 'object') return undefined;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, part);
    } catch {
      throw new PolicyError();
    }
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    value = descriptor.value;
  }
  return value;
}

function matchesCondition(request: ParsedRequest, condition: PolicyCondition): boolean {
  const actual = readField(request, condition.field);
  const expected = condition.value;
  switch (condition.op) {
    case 'exists':
      return expected === false ? actual === undefined : actual !== undefined;
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== undefined && actual !== expected;
    case 'in':
      return Array.isArray(expected) && expected.some((value) => value === actual);
    case 'notIn':
      return (
        actual !== undefined &&
        Array.isArray(expected) &&
        !expected.some((value) => value === actual)
      );
    case 'startsWith':
      return (
        typeof actual === 'string' && typeof expected === 'string' && actual.startsWith(expected)
      );
    case 'endsWith':
      return (
        typeof actual === 'string' && typeof expected === 'string' && actual.endsWith(expected)
      );
    case 'allEndsWith':
      return (
        Array.isArray(actual) &&
        actual.length > 0 &&
        typeof expected === 'string' &&
        actual.every((value: unknown) => typeof value === 'string' && value.endsWith(expected))
      );
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string'
        ? actual.includes(expected)
        : Array.isArray(actual) && actual.some((value: unknown) => value === expected);
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
  }
}

function matchesRule(request: ParsedRequest, effect: ToolEffect, rule: PolicyRule): boolean {
  if (rule.scope.type === 'project' && rule.scope.projectId !== request.projectId) return false;
  if (
    rule.scope.type === 'agent' &&
    (rule.scope.agentId !== request.agentId ||
      (rule.scope.projectId !== undefined && rule.scope.projectId !== request.projectId))
  )
    return false;
  const match = rule.match;
  if (match.tool !== undefined && match.tool !== '*') {
    if (match.tool.endsWith('.*')) {
      if (!request.tool.startsWith(match.tool.slice(0, -1))) return false;
    } else if (match.tool !== request.tool) return false;
  }
  if (match.effect !== undefined) {
    const effects = Array.isArray(match.effect) ? match.effect : [match.effect];
    if (!effects.includes(effect)) return false;
  }
  if (match.connector !== undefined && match.connector !== request.connector) return false;
  if (match.scope !== undefined && match.scope !== request.scope) return false;
  return rule.when.every((condition) => matchesCondition(request, condition));
}

function specificity(rule: PolicyRule): number {
  const scope = rule.scope.type === 'agent' ? 300 : rule.scope.type === 'project' ? 200 : 100;
  const tool =
    rule.match.tool === undefined || rule.match.tool === '*'
      ? 0
      : rule.match.tool.endsWith('.*')
        ? 10
        : 20;
  return scope + tool + Object.keys(rule.match).length + rule.when.length;
}

function defaultAction(
  preset: PolicyPreset,
  request: ParsedRequest,
  effect: ToolEffect,
): PolicyDecision['action'] {
  switch (effect) {
    case 'read':
      return 'allow';
    case 'write':
      return preset === 'cautious'
        ? 'ask'
        : request.scope === 'internal' || preset === 'autonomous'
          ? 'allow'
          : 'ask';
    case 'send':
      return preset === 'autonomous' && request.knownRecipient ? 'allow' : 'ask';
    case 'delete':
    case 'publish':
      return preset === 'cautious' ? 'deny' : 'ask';
    case 'spend':
      return preset === 'autonomous' ? 'ask' : 'deny';
  }
}

function outsideWindow(rule: PolicyRule, now: Date): boolean {
  const window = rule.timeWindow;
  if (window === undefined) return false;
  if (window.weekdaysUtc !== undefined && !window.weekdaysUtc.includes(now.getUTCDay()))
    return true;
  const hour = now.getUTCHours();
  return window.startHourUtc === window.endHourUtc
    ? false
    : window.startHourUtc < window.endHourUtc
      ? hour < window.startHourUtc || hour >= window.endHourUtc
      : hour < window.startHourUtc && hour >= window.endHourUtc;
}

/** Pure policy evaluation. Callers persist the decision and trusted usage counters transactionally. */
export function evaluatePolicy(input: PolicyRequest): PolicyDecision {
  const parsed = policyRequestSchema.safeParse(input);
  if (!parsed.success) throw new PolicyError();
  const request = parsed.data;
  const normalized = normalizeEffect(request.effect);
  const effect = normalized.effect;
  const known = normalized.known && request.effectKnown !== false;
  const baseline: Candidate = {
    action: defaultAction(request.preset, request, effect),
    reason: `The ${request.preset} preset applies to this effect.`,
    ruleId: `preset:${request.preset}:${effect}:${request.scope}`,
    specificity: 0,
  };
  const candidates: Candidate[] = [baseline];
  if (request.allowedEffects && !request.allowedEffects.includes(known ? effect : 'write'))
    candidates.push({
      action: 'deny',
      reason: 'This recipe does not permit this effect.',
      ruleId: 'recipe:effect-limit',
      specificity: 10_005,
    });
  if (request.askEffects?.includes(effect))
    candidates.push({
      action: 'ask',
      reason: 'This recipe requires approval for this effect.',
      ruleId: 'recipe:approval',
      specificity: 10_005,
    });
  const rules = request.rules.filter((rule) => matchesRule(request, effect, rule));
  for (const rule of rules) {
    candidates.push({
      action: rule.action,
      reason: 'A matching policy rule applies.',
      ruleId: rule.id,
      specificity: specificity(rule),
    });
    if (rule.action === 'allow') {
      const usage = request.usage?.[rule.id];
      if (
        (rule.limits?.perHour !== undefined &&
          (usage === undefined || usage.hour >= rule.limits.perHour)) ||
        (rule.limits?.perRun !== undefined &&
          (usage === undefined || usage.run >= rule.limits.perRun)) ||
        outsideWindow(rule, request.now ?? new Date())
      )
        candidates.push({
          action: 'ask',
          reason: 'A policy limit or allowed time window requires approval.',
          ruleId: `${rule.id}:limit`,
          specificity: specificity(rule),
        });
    }
  }
  if (!known)
    candidates.push({
      action: 'ask',
      reason: 'An unknown effect is treated as a write requiring approval.',
      ruleId: 'safety:unknown-effect',
      specificity: 10_000,
    });
  if (
    request.tainted &&
    (['send', 'publish', 'delete', 'spend'].includes(effect) ||
      (effect === 'write' && request.scope === 'external'))
  ) {
    candidates.push({
      action: 'ask',
      reason: 'Proposed after reading external content.',
      ruleId: 'safety:tainted',
      specificity: 10_001,
    });
  }
  if (
    request.moneyMovement ||
    /^(?:payments?|trading|securities|banking)(?:\.|$)/.test(request.tool)
  ) {
    candidates.push({
      action: 'deny',
      reason: 'Money movement and securities trading are disabled.',
      ruleId: 'safety:money-movement',
      specificity: 10_002,
    });
  }
  if (
    request.budget !== undefined &&
    (request.budget.remainingSteps <= 0 ||
      request.budget.remainingMs <= 0 ||
      request.budget.remainingUsd < request.budget.estimatedCostUsd)
  ) {
    candidates.push({
      action: 'deny',
      reason: 'The run budget is exhausted.',
      ruleId: 'safety:budget',
      specificity: 10_003,
    });
  }
  if (request.paused)
    candidates.push({
      action: 'deny',
      reason: 'Agents are paused by the kill switch.',
      ruleId: 'safety:paused',
      specificity: 10_004,
    });
  candidates.sort(
    (left, right) =>
      precedence[right.action] - precedence[left.action] ||
      right.specificity - left.specificity ||
      left.ruleId.localeCompare(right.ruleId),
  );
  const selected = candidates[0]!;
  return {
    action: selected.action,
    reason: selected.reason,
    ruleId: selected.ruleId,
    effect,
    matchedRuleIds: [...new Set(candidates.map((candidate) => candidate.ruleId))],
  };
}
