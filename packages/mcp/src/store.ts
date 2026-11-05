import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  mcpConfigurationSchema,
  mcpSaveSchema,
  mcpServerSchema,
  integrationControlSchema,
  McpError,
  type McpConfiguration,
} from '@sazuz/core/mcp';
import { workId } from '@sazuz/core/work';
import {
  auditLog,
  jsonValue,
  mcpServers,
  mcpServerVersions,
  missionContext,
  projects,
  runMcpSelections,
  settingsHistory,
  valueHash,
  workKey,
  type Database,
  type Transaction,
} from '@sazuz/db';
import { secretRedactor } from '@sazuz/vault';
import type { McpConnection } from './client.js';
import { boundedJson, mcpToolName } from './catalogue.js';

export async function ownedProject(db: Database, userId: string, projectId: string) {
  const [row] = await db.orm
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  if (!row) throw new McpError('MCP_DENIED');
  return row;
}
async function revision(db: Database, userId: string, id: string, version?: number) {
  const [row] = await db.orm
    .select({ server: mcpServers, revision: mcpServerVersions })
    .from(mcpServers)
    .innerJoin(
      mcpServerVersions,
      and(
        eq(mcpServerVersions.serverId, mcpServers.id),
        version === undefined
          ? eq(mcpServerVersions.version, mcpServers.currentVersion)
          : eq(mcpServerVersions.version, version),
      ),
    )
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)));
  if (!row) throw new McpError('MCP_DENIED');
  return row;
}
export async function getMcpServer(db: Database, userId: string, id: string, version?: number) {
  const row = await revision(db, userId, id, version);
  return mcpServerSchema.parse({
    id,
    projectId: row.server.projectId,
    version: row.revision.version,
    configuration: row.revision.configuration,
    warning: row.server.warning,
    updatedAt: row.server.updatedAt.toISOString(),
  });
}
export async function listMcpServers(db: Database, userId: string) {
  const rows = await db.orm
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(eq(mcpServers.userId, userId))
    .limit(100);
  return Promise.all(rows.map((row) => getMcpServer(db, userId, row.id)));
}
export async function mcpHistory(db: Database, userId: string, id: string) {
  await revision(db, userId, id);
  const rows = await db.orm
    .select({ version: mcpServerVersions.version })
    .from(mcpServerVersions)
    .where(eq(mcpServerVersions.serverId, id))
    .orderBy(desc(mcpServerVersions.version))
    .limit(100);
  return Promise.all(rows.map((row) => getMcpServer(db, userId, id, row.version)));
}
async function append(
  tx: Transaction,
  userId: string,
  serverId: string,
  version: number,
  configuration: McpConfiguration,
) {
  await tx.insert(mcpServerVersions).values({
    id: workKey('mcv'),
    serverId,
    version,
    configuration: jsonValue(configuration),
    sha256: valueHash(configuration),
  });
  await tx.insert(settingsHistory).values({
    namespace: `mcp:${serverId}`,
    version,
    value: jsonValue(configuration),
    actorId: userId,
  });
  await tx.insert(auditLog).values({
    id: workKey('aud'),
    actorId: userId,
    action: 'mcp.configured',
    target: `${serverId}:${version}`,
  });
  await tx.execute(sql`SELECT pg_notify('settings_changed',${`mcp:${serverId}`})`);
  await tx.execute(sql`SELECT pg_notify('execution_changed',${serverId})`);
}
async function assertInstallationLimits(
  tx: Transaction,
  projectId: string,
  id: string | null,
  configuration: McpConfiguration,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mcp-project:${projectId}`},0))`,
  );
  const installed = await tx
    .select({ configuration: mcpServerVersions.configuration, id: mcpServers.id })
    .from(mcpServers)
    .innerJoin(
      mcpServerVersions,
      and(
        eq(mcpServerVersions.serverId, mcpServers.id),
        eq(mcpServerVersions.version, mcpServers.currentVersion),
      ),
    )
    .where(and(eq(mcpServers.projectId, projectId), eq(mcpServers.enabled, true)));
  const others = installed.filter((row) => row.id !== id);
  if (others.length >= 20) throw new McpError('MCP_INVALID');
  const totals = new Map<string, number>();
  for (const config of [
    ...others.map((row) => mcpConfigurationSchema.parse(row.configuration)),
    configuration,
  ])
    for (const permission of config.permissions.filter((entry) => entry.enabled))
      for (const agent of permission.agents) totals.set(agent, (totals.get(agent) ?? 0) + 1);
  if ([...totals.values()].some((count) => count > 64)) throw new McpError('MCP_INVALID');
}
export async function saveMcpServer(
  db: Database,
  userId: string,
  id: string | null,
  input: unknown,
  connect: McpConnection,
) {
  boundedJson(input, 262_144, 20);
  const value = mcpSaveSchema.parse(input);
  await ownedProject(db, userId, value.projectId);
  if (id ? value.expectedVersion < 1 : value.expectedVersion !== 0)
    throw new McpError('MCP_CONFLICT');
  if (id && (await getMcpServer(db, userId, id)).projectId !== value.projectId)
    throw new McpError('MCP_DENIED');
  const discovered = await connect(
    value.transport,
    { projectId: value.projectId, agentId: 'owner', signal: AbortSignal.timeout(45_000) },
    (_client, found) => Promise.resolve(found),
  );
  if (discovered.sha256 !== value.expectedPin) throw new McpError('MCP_CHANGED');
  const names = new Set(discovered.tools.map((tool) => tool.name));
  if (
    new Set(value.permissions.map((entry) => entry.tool)).size !== value.permissions.length ||
    value.permissions.some((entry) => !names.has(entry.tool))
  )
    throw new McpError('MCP_INVALID');
  const configuration = mcpConfigurationSchema.parse({
    name: value.name,
    transport: value.transport,
    catalogue: discovered,
    permissions: discovered.tools.map(
      (tool) =>
        value.permissions.find((entry) => entry.tool === tool.name) ?? {
          tool: tool.name,
          effect: null,
          agents: [],
          enabled: true,
          moneyMovement: false,
        },
    ),
    enabled: true,
  });
  if (valueHash(configuration) !== valueHash(secretRedactor.redact(configuration)))
    throw new McpError('MCP_DENIED');
  const serverId = id ?? workKey('mcp');
  await db.orm.transaction(async (tx) => {
    await assertInstallationLimits(tx, value.projectId, id, configuration);
    if (id) {
      const changed = await tx
        .update(mcpServers)
        .set({
          currentVersion: value.expectedVersion + 1,
          enabled: true,
          warning: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mcpServers.id, id),
            eq(mcpServers.userId, userId),
            eq(mcpServers.currentVersion, value.expectedVersion),
          ),
        )
        .returning();
      if (!changed.length) throw new McpError('MCP_CONFLICT');
    } else await tx.insert(mcpServers).values({ id: serverId, userId, projectId: value.projectId });
    await append(tx, userId, serverId, value.expectedVersion + 1, configuration);
  });
  return getMcpServer(db, userId, serverId);
}
export async function controlMcpServer(db: Database, userId: string, id: string, input: unknown) {
  const value = integrationControlSchema.parse(input),
    current = await getMcpServer(db, userId, id);
  await db.orm.transaction(async (tx) => {
    if (value.enabled)
      await assertInstallationLimits(tx, current.projectId, id, current.configuration);
    const changed = await tx
      .update(mcpServers)
      .set({
        currentVersion: value.expectedVersion + 1,
        enabled: value.enabled,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mcpServers.id, id),
          eq(mcpServers.userId, userId),
          eq(mcpServers.currentVersion, value.expectedVersion),
        ),
      )
      .returning();
    if (!changed.length || current.version !== value.expectedVersion)
      throw new McpError('MCP_CONFLICT');
    await append(tx, userId, id, value.expectedVersion + 1, {
      ...current.configuration,
      enabled: value.enabled,
    });
  });
  return getMcpServer(db, userId, id);
}
export interface SelectedMcp {
  serverId: string;
  revisionId: string;
  version: number;
  configuration: McpConfiguration;
}
export async function selectedMcp(
  db: Database,
  runId: string,
  pin = false,
): Promise<SelectedMcp[]> {
  const context = await missionContext(db, runId);
  if (!context) throw new McpError('MCP_DENIED');
  if (pin)
    await db.orm.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mcp-run:${runId}`},0))`,
      );
      if (
        (await tx.select().from(runMcpSelections).where(eq(runMcpSelections.runId, runId))).length
      )
        return;
      let revisionIds: unknown;
      if (context.run.parentRunId) {
        const [parent] = await tx
          .select()
          .from(runMcpSelections)
          .where(eq(runMcpSelections.runId, context.run.parentRunId));
        revisionIds = parent?.revisionIds ?? [];
      } else {
        const rows = await tx
          .select({ id: mcpServerVersions.id })
          .from(mcpServers)
          .innerJoin(
            mcpServerVersions,
            and(
              eq(mcpServerVersions.serverId, mcpServers.id),
              eq(mcpServerVersions.version, mcpServers.currentVersion),
            ),
          )
          .where(
            and(
              eq(mcpServers.projectId, context.project.id),
              eq(mcpServers.userId, context.project.userId),
              eq(mcpServers.enabled, true),
            ),
          );
        revisionIds = rows.map((row) => row.id);
      }
      await tx
        .insert(runMcpSelections)
        .values({ runId, revisionIds: jsonValue(z.array(workId).max(20).parse(revisionIds)) });
    });
  const [selection] = await db.orm
    .select()
    .from(runMcpSelections)
    .where(eq(runMcpSelections.runId, runId));
  const ids = z
    .array(workId)
    .max(20)
    .parse(selection?.revisionIds ?? []);
  if (!ids.length) return [];
  const rows = await db.orm
    .select({ server: mcpServers, revision: mcpServerVersions })
    .from(mcpServerVersions)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpServerVersions.serverId))
    .where(inArray(mcpServerVersions.id, ids));
  if (
    rows.length !== ids.length ||
    rows.some(
      (row) =>
        row.server.userId !== context.project.userId || row.server.projectId !== context.project.id,
    )
  )
    throw new McpError('MCP_DENIED');
  return rows.map((row) => ({
    serverId: row.server.id,
    revisionId: row.revision.id,
    version: row.revision.version,
    configuration: mcpConfigurationSchema.parse(row.revision.configuration),
  }));
}
export async function assertMcpCurrent(db: Database, selection: SelectedMcp) {
  const [row] = await db.orm.select().from(mcpServers).where(eq(mcpServers.id, selection.serverId));
  if (!row?.enabled || row.currentVersion !== selection.version || !selection.configuration.enabled)
    throw new McpError('MCP_DENIED');
  if (row.warning) throw new McpError('MCP_CHANGED');
}
export async function markMcpChanged(
  db: Database,
  selection: Pick<SelectedMcp, 'serverId' | 'version'>,
) {
  await db.orm
    .update(mcpServers)
    .set({
      warning: 'The server catalogue changed. Inspect it and review a new installation revision.',
      updatedAt: new Date(),
    })
    .where(
      and(eq(mcpServers.id, selection.serverId), eq(mcpServers.currentVersion, selection.version)),
    );
}
export async function mcpActionAllowed(db: Database, runId: string, agentId: string, name: string) {
  const selection = (await selectedMcp(db, runId)).find((item) =>
    item.configuration.permissions.some(
      (permission) =>
        permission.enabled &&
        permission.agents.some((role) => role === agentId) &&
        mcpToolName(item.serverId, permission.tool) === name,
    ),
  );
  if (!selection) return false;
  try {
    await assertMcpCurrent(db, selection);
    return true;
  } catch (error) {
    if (error instanceof McpError) return false;
    throw error;
  }
}
