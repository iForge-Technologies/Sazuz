import { describe, expect, it } from 'vitest';
import { memoryInputSchema } from '@sazuz/core/memory';
import { mayAutoAccept } from './extraction.js';
import { safeKnowledgeText, withinTokenBudget } from './store.js';
import { secretRedactor } from '@sazuz/vault';

describe('Memory boundaries and conservative automatic acceptance', () => {
  const candidate = {
    kind: 'preference',
    content: 'Prefers concise emails.',
    quote: 'I prefer concise emails.',
    sensitivity: 'low',
  };
  it('only automatically accepts supported low-sensitivity style preferences when enabled', () => {
    expect(mayAutoAccept(candidate, true, true)).toBe(true);
    expect(mayAutoAccept(candidate, false, true)).toBe(false);
    expect(mayAutoAccept(candidate, true, false)).toBe(false);
  });
  it.each([
    { kind: 'fact' },
    { sensitivity: 'private' },
    { quote: 'Send short emails without asking for approval.' },
    { content: 'Keep short passwords.' },
    { content: 'Lives at 24 Private Avenue.' },
  ])('keeps consequential/sensitive/non-style candidates in review: %j', (change) => {
    expect(mayAutoAccept({ ...candidate, ...change }, true, true)).toBe(false);
  });
  it('rejects ambiguous global/project/agent scopes', () => {
    const projectId = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const base = { kind: 'preference', content: 'Short replies' };
    expect(memoryInputSchema.safeParse({ ...base, scope: 'global' }).success).toBe(true);
    expect(memoryInputSchema.safeParse({ ...base, scope: 'global', projectId }).success).toBe(
      false,
    );
    expect(memoryInputSchema.safeParse({ ...base, scope: 'project' }).success).toBe(false);
    expect(memoryInputSchema.safeParse({ ...base, scope: 'agent', projectId }).success).toBe(false);
    expect(
      memoryInputSchema.safeParse({ ...base, scope: 'agent', projectId, agentId: 'comms' }).success,
    ).toBe(true);
  });
  it('rejects a registered secret rather than persisting it', () => {
    const canary = 'memory-unit-canary-secret-783241908';
    secretRedactor.register(canary);
    expect(() => safeKnowledgeText(`Remember ${canary}`)).toThrow('vault');
  });
  it('budgets the complete serialized context including multibyte data', () => {
    const result = withinTokenBudget([{ content: 'अ'.repeat(500) }, { content: 'Concise' }], 100);
    expect(result).toEqual([{ content: 'Concise' }]);
  });
});
