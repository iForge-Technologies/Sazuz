import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, stringify } from 'yaml';
import { agentDefinitionSchema, agentRoleSchema, type AgentDefinition } from '@sazuz/core/agents';
import { secretRedactor } from '@sazuz/vault';
import { canonicalJson } from '@sazuz/db';
import { OrchestrationError } from './errors.js';

export function parseAgent(value: unknown): AgentDefinition {
  if (typeof value === 'string') {
    if (value.length > 24000 || Buffer.byteLength(value) > 72000)
      throw new OrchestrationError('AGENT_INVALID');
    try {
      const document = parseDocument(value, { uniqueKeys: true, strict: true, schema: 'core' });
      if (document.errors.length || document.warnings.length)
        throw new OrchestrationError('AGENT_INVALID');
      value = document.toJS({ maxAliasCount: 0 }) as unknown;
    } catch {
      throw new OrchestrationError('AGENT_INVALID');
    }
  }
  const parsed = agentDefinitionSchema.safeParse(value);
  if (!parsed.success) throw new OrchestrationError('AGENT_INVALID');
  if (JSON.stringify(secretRedactor.redact(parsed.data)) !== JSON.stringify(parsed.data))
    throw new OrchestrationError('AGENT_SECRET');
  return parsed.data;
}
export const agentHash = (definition: AgentDefinition) =>
  createHash('sha256').update(canonicalJson(definition)).digest('hex');
export const agentYaml = (definition: AgentDefinition) => stringify(definition);
export async function readDefaultAgents(
  directory = fileURLToPath(new URL('../../../agents/', import.meta.url)),
) {
  return Promise.all(
    agentRoleSchema.options.map(async (role) => {
      const definition = parseAgent(await readFile(resolve(directory, role + '.yaml'), 'utf8'));
      if (definition.id !== role) throw new OrchestrationError('AGENT_INVALID');
      return definition;
    }),
  );
}
export const matchesTool = (patterns: readonly string[], name: string) =>
  patterns.some((pattern) =>
    pattern.endsWith('.*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
  );
export function permitsTool(definition: AgentDefinition, name: string, effect?: string) {
  if (
    !definition.enabled ||
    !matchesTool(definition.tools, name) ||
    matchesTool(definition.permissions.deny, name)
  )
    return false;
  if (definition.id === 'auditor' && effect !== 'read') return false;
  if (definition.memory.write === 'none' && ['memory.propose', 'memory.forget'].includes(name))
    return false;
  return true;
}
