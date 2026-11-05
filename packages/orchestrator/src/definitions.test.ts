import { describe, expect, it } from 'vitest';
import { secretRedactor } from '@sazuz/vault';
import { agentDefinitionSchema } from '@sazuz/core/agents';
import { parseAgent, readDefaultAgents, permitsTool } from './definitions.js';

describe('bounded agent definitions and permissions', () => {
  it('loads all ten identities with restrictive role-specific defaults', async () => {
    const agents = await readDefaultAgents();
    expect(agents).toHaveLength(10);
    const researcher = agents.find((agent) => agent.id === 'researcher')!;
    expect(permitsTool(researcher, 'web.fetch', 'read')).toBe(true);
    expect(permitsTool(researcher, 'gmail.send', 'send')).toBe(false);
    expect(agents.every((agent) => agent.identity.connector_accounts.length === 0)).toBe(true);
    const auditor = agents.find((agent) => agent.id === 'auditor')!;
    expect(permitsTool(auditor, 'files.read', 'read')).toBe(true);
    expect(permitsTool(auditor, 'files.read', 'write')).toBe(false);
  });
  it.each([
    'id: &x [*x]',
    'id: !!js/function function(){}',
    'id: cos\nid: comms',
    'x'.repeat(24001),
  ])('rejects hostile or ambiguous YAML', (yaml) => {
    expect(() => parseAgent(yaml)).toThrow();
  });
  it('rejects known secrets and unknown authority fields', async () => {
    const [agent] = await readDefaultAgents();
    const value = 'phase6-agent-secret-canary-8917625';
    secretRedactor.register(value);
    expect(() => parseAgent({ ...agent, instructions: value })).toThrow('credentials');
    expect(() => parseAgent({ ...agent, unrestricted: true })).toThrow();
  });
  it('denies disabled identities, explicit denies and forbidden memory writes', async () => {
    const [base] = await readDefaultAgents();
    const definition = agentDefinitionSchema.parse({
      ...base,
      tools: ['files.*', 'memory.*'],
      memory: { read: [], write: 'none' },
      permissions: { preset: 'inherit', deny: ['files.delete'] },
    });
    expect(permitsTool(definition, 'files.delete', 'delete')).toBe(false);
    expect(permitsTool(definition, 'memory.propose', 'write')).toBe(false);
    expect(permitsTool({ ...definition, enabled: false }, 'files.read', 'read')).toBe(false);
  });
});
