import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  agentDefinitionSchema,
  agentRevisionSchema,
  agentSummarySchema,
  agentWriteSchema,
  type AgentDefinition,
  type AgentRole,
} from '@sazuz/core/agents';
import {
  agents,
  agentVersions,
  agentIdentities,
  runAgentVersions,
  auditLog,
  jsonValue,
  workKey,
  valueHash,
  type Database,
  type Transaction,
} from '@sazuz/db';
import {
  assertAccountPermission,
  connectorAccountSchema,
  connectorActions,
  type ConnectorPermission,
} from '@sazuz/connectors';
import type { SettingsValues } from '@sazuz/config/settings';
import { parseAgent, readDefaultAgents, agentHash, agentYaml, permitsTool } from './definitions.js';
import { OrchestrationError } from './errors.js';

type Accounts = SettingsValues['connectors']['accounts'];
type AgentTx = Database['orm'] | Transaction;
async function appendRevision(
  tx: Transaction,
  agentId: string,
  version: number,
  definition: AgentDefinition,
) {
  await tx.insert(agentVersions).values({
    id: workKey('agv'),
    agentId,
    version,
    definition: jsonValue(definition),
    sha256: agentHash(definition),
  });
  await tx
    .insert(agentIdentities)
    .values({
      agentId,
      display: definition.identity.display,
      connectorAccounts: jsonValue(definition.identity.connector_accounts),
    })
    .onConflictDoUpdate({
      target: agentIdentities.agentId,
      set: {
        display: definition.identity.display,
        connectorAccounts: jsonValue(definition.identity.connector_accounts),
        updatedAt: new Date(),
      },
    });
}
const inheritedPermissions: Partial<Record<AgentRole, readonly ConnectorPermission[]>> = {
  comms: [
    'email:read',
    'email:draft',
    'email:send',
    'calendar:read',
    'calendar:write',
    'calendar:delete',
  ],
  researcher: ['calendar:read', 'github:read'],
  coder: ['github:read', 'github:write'],
};
/** Freeze pre-Phase-6 role/account access once. Newly connected accounts require explicit grants. */
export async function ensureAgents(db: Database, userId: string, accounts: Accounts = []) {
  const existing = await db.orm
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.userId, userId))
    .limit(1);
  if (existing.length) return;
  const defaults = await readDefaultAgents();
  await db.orm.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'agents:' + userId},0))`);
    if (
      (await tx.select({ id: agents.id }).from(agents).where(eq(agents.userId, userId)).limit(1))
        .length
    )
      return;
    for (const base of defaults) {
      const definition = structuredClone(base);
      for (const value of accounts) {
        const parsed = connectorAccountSchema.safeParse(value);
        if (!parsed.success || !parsed.data.provider) continue;
        const account = parsed.data;
        const permissions = (inheritedPermissions[base.id] ?? []).filter((permission) => {
          try {
            assertAccountPermission(account, account.provider!, permission);
            return true;
          } catch {
            return false;
          } // Expected incompatible account/scope; never resolve credentials here.
        });
        if (permissions.length)
          definition.identity.connector_accounts.push({
            accountId: account.id,
            permissions: [...permissions],
          });
      }
      const id = workKey('ag');
      await tx.insert(agents).values({ id, userId, role: definition.id });
      await appendRevision(tx, id, 1, definition);
    }
    await tx.insert(auditLog).values({
      id: workKey('aud'),
      actorId: userId,
      action: 'agents.initialized',
      target: 'default-team',
    });
  });
}
async function revision(tx: AgentTx, userId: string, roleOrId: string, version?: number) {
  const [row] = await tx
    .select({ agent: agents, revision: agentVersions })
    .from(agents)
    .innerJoin(
      agentVersions,
      and(
        eq(agentVersions.agentId, agents.id),
        version === undefined
          ? eq(agentVersions.version, agents.currentVersion)
          : eq(agentVersions.version, version),
      ),
    )
    .where(
      and(eq(agents.userId, userId), sql`(${agents.id}=${roleOrId} OR ${agents.role}=${roleOrId})`),
    );
  if (!row) throw new OrchestrationError('AGENT_NOT_FOUND');
  return row;
}
function publicRevision(row: Awaited<ReturnType<typeof revision>>) {
  const definition = agentDefinitionSchema.parse(row.revision.definition);
  return agentRevisionSchema.parse({
    id: row.agent.id,
    role: row.agent.role,
    version: row.revision.version,
    sha256: row.revision.sha256,
    definition,
    yaml: agentYaml(definition),
    createdAt: row.revision.createdAt.toISOString(),
  });
}
export async function getAgent(db: Database, userId: string, id: string, version?: number) {
  return publicRevision(await revision(db.orm, userId, id, version));
}
export async function listAgents(db: Database, userId: string) {
  const rows = await db.orm
    .select()
    .from(agents)
    .where(eq(agents.userId, userId))
    .orderBy(asc(agents.role));
  return Promise.all(
    rows.map(async (row) => {
      const value = await getAgent(db, userId, row.id);
      const def = value.definition;
      return agentSummarySchema.parse({
        id: row.id,
        role: row.role,
        version: value.version,
        name: def.name,
        description: def.description,
        enabled: def.enabled,
        modelRole: def.model.role,
        display: def.identity.display,
        accounts: def.identity.connector_accounts.length,
      });
    }),
  );
}
export async function agentHistory(db: Database, userId: string, id: string) {
  const { agent } = await revision(db.orm, userId, id);
  const rows = await db.orm
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agent.id))
    .orderBy(desc(agentVersions.version));
  return rows.map((row) => publicRevision({ agent, revision: row }));
}
export async function saveAgent(
  db: Database,
  userId: string,
  id: string,
  input: unknown,
  accounts: Accounts,
) {
  const parsed = agentWriteSchema.safeParse(input);
  if (!parsed.success) throw new OrchestrationError('AGENT_INVALID');
  const definition = parseAgent(parsed.data.definition ?? parsed.data.yaml);
  for (const grant of definition.identity.connector_accounts) {
    const value = accounts.find((account) => account.id === grant.accountId);
    const account = connectorAccountSchema.safeParse(value);
    if (!account.success || !account.data.provider)
      throw new OrchestrationError('AGENT_SCOPE_DENIED');
    for (const permission of grant.permissions) {
      try {
        assertAccountPermission(account.data, account.data.provider, permission);
      } catch {
        throw new OrchestrationError('AGENT_SCOPE_DENIED');
      }
    }
  }
  await db.orm.transaction(async (tx) => {
    const { agent } = await revision(tx, userId, id);
    if (agent.role !== definition.id) throw new OrchestrationError('AGENT_INVALID');
    const next = parsed.data.expectedVersion + 1;
    const changed = await tx
      .update(agents)
      .set({ currentVersion: next, updatedAt: new Date() })
      .where(and(eq(agents.id, agent.id), eq(agents.currentVersion, parsed.data.expectedVersion)))
      .returning({ id: agents.id });
    if (!changed.length) throw new OrchestrationError('AGENT_CONFLICT');
    await appendRevision(tx, agent.id, next, definition);
    await tx.insert(auditLog).values({
      id: workKey('aud'),
      actorId: userId,
      action: 'agent.updated',
      target: agent.id + ':' + next,
    });
    await tx.execute(sql`SELECT pg_notify('agents_changed',${agent.id})`);
  });
  return getAgent(db, userId, id);
}
export async function rollbackAgent(
  db: Database,
  userId: string,
  id: string,
  expectedVersion: number,
  version: number,
  accounts: Accounts,
) {
  const old = await getAgent(db, userId, id, version);
  return saveAgent(db, userId, id, { expectedVersion, definition: old.definition }, accounts);
}
export async function pinAgent(
  db: Database,
  userId: string,
  runId: string,
  role: AgentRole,
  accounts: Accounts,
) {
  await ensureAgents(db, userId, accounts);
  const current = await revision(db.orm, userId, role);
  if (!agentDefinitionSchema.parse(current.revision.definition).enabled)
    throw new OrchestrationError('AGENT_DISABLED');
  await db.orm
    .insert(runAgentVersions)
    .values({
      runId,
      role,
      revisionId: current.revision.id,
      connectorBindings: Object.fromEntries(
        accounts.map((account) => [account.id, connectorBinding(account)]),
      ),
    })
    .onConflictDoNothing();
  return runAgent(db, userId, runId, role);
}
export async function runAgent(db: Database, userId: string, runId: string, role: AgentRole) {
  const [row] = await db.orm
    .select({ revision: agentVersions })
    .from(runAgentVersions)
    .innerJoin(agentVersions, eq(agentVersions.id, runAgentVersions.revisionId))
    .innerJoin(agents, eq(agents.id, agentVersions.agentId))
    .where(
      and(
        eq(runAgentVersions.runId, runId),
        eq(runAgentVersions.role, role),
        eq(agents.userId, userId),
        eq(agents.role, role),
      ),
    );
  if (!row) throw new OrchestrationError('AGENT_NOT_FOUND');
  return agentDefinitionSchema.parse(row.revision.definition);
}
export async function hasPinnedAgent(db: Database, runId: string, role: AgentRole) {
  return (
    (
      await db.orm
        .select({ runId: runAgentVersions.runId })
        .from(runAgentVersions)
        .where(and(eq(runAgentVersions.runId, runId), eq(runAgentVersions.role, role)))
        .limit(1)
    ).length > 0
  );
}
export async function agentActionPermission(
  db: Database,
  userId: string,
  runId: string,
  role: AgentRole,
  name: string,
  args: unknown,
  effect: string,
  accounts: Accounts,
) {
  const pinned = await runAgent(db, userId, runId, role);
  const current = (await getAgent(db, userId, role)).definition;
  if (!permitsTool(pinned, name, effect) || !permitsTool(current, name, effect)) return false;
  const action = connectorActions[name];
  if (!action) return true;
  const accountId =
    typeof args === 'object' && args !== null && 'accountId' in args ? args.accountId : undefined;
  if (typeof accountId !== 'string') return false;
  const granted = (definition: AgentDefinition) =>
    definition.identity.connector_accounts.some(
      (grant) => grant.accountId === accountId && grant.permissions.includes(action.permission),
    );
  if (!granted(pinned) || !granted(current)) return false;
  const account = connectorAccountSchema.safeParse(
    accounts.find((value) => value.id === accountId),
  );
  if (!account.success) return false;
  const [selection] = await db.orm
    .select({ bindings: runAgentVersions.connectorBindings })
    .from(runAgentVersions)
    .where(and(eq(runAgentVersions.runId, runId), eq(runAgentVersions.role, role)));
  const bindings = selection?.bindings;
  if (
    !bindings ||
    typeof bindings !== 'object' ||
    !Reflect.has(bindings, accountId) ||
    valueHash(Reflect.get(bindings, accountId)) !== valueHash(connectorBinding(account.data))
  )
    return false;
  try {
    assertAccountPermission(account.data, action.provider, action.permission);
    return true;
  } catch {
    return false;
  }
}

function connectorBinding(account: {
  id: string;
  provider: string | null;
  secretRef: string | null;
  options: unknown;
}) {
  return {
    id: account.id,
    provider: account.provider,
    secretRef: account.secretRef,
    options: account.options,
  };
}
export async function agentAuditIdentity(
  db: Database,
  userId: string,
  runId: string,
  role: AgentRole,
) {
  const definition = await runAgent(db, userId, runId, role);
  return definition.identity.display + ' (on behalf of ' + userId + ')';
}
