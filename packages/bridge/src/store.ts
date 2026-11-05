import { createHash, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  BridgeError,
  bridgeDeviceInputSchema,
  bridgeDeviceSchema,
  bridgeGrantSchema,
  bridgeHelloSchema,
  bridgeInputs,
  bridgeManifestSchema,
  bridgeSaveSchema,
  bridgeToolSchema,
  type BridgeGrant,
  type BridgeManifest,
} from '@sazuz/core/bridge';
import { integrationControlSchema } from '@sazuz/core/mcp';
import { workId } from '@sazuz/core/work';
import {
  auditLog,
  bridgeDevices,
  bridgeDeviceVersions,
  jsonValue,
  missionContext,
  projects,
  runBridgeSelections,
  settingsHistory,
  valueHash,
  workKey,
  type Database,
  type Transaction,
} from '@sazuz/db';
import { secretRedactor, type SecretReference } from '@sazuz/vault';
import type { McpSecretResolver } from '@sazuz/mcp';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
async function ownedProject(db: Database, userId: string, projectId: string) {
  const [row] = await db.orm
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  if (!row) throw new BridgeError('BRIDGE_DENIED');
}
async function deviceRow(db: Database, id: string, userId?: string) {
  const [row] = await db.orm
    .select({ device: bridgeDevices, revision: bridgeDeviceVersions })
    .from(bridgeDevices)
    .innerJoin(
      bridgeDeviceVersions,
      and(
        eq(bridgeDeviceVersions.deviceId, bridgeDevices.id),
        eq(bridgeDeviceVersions.version, bridgeDevices.version),
      ),
    )
    .where(and(eq(bridgeDevices.id, id), ...(userId ? [eq(bridgeDevices.userId, userId)] : [])));
  if (!row) throw new BridgeError('BRIDGE_DENIED');
  return row;
}
export async function getBridgeDevice(db: Database, userId: string, id: string) {
  const { device, revision } = await deviceRow(db, id, userId);
  return bridgeDeviceSchema.parse({
    id,
    name: device.name,
    projectId: device.projectId,
    secretRef: device.secretRef,
    version: device.version,
    enabled: device.enabled,
    online:
      device.enabled &&
      device.connectionId !== null &&
      (device.lastSeenAt?.getTime() ?? 0) > Date.now() - 20000,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    offered: device.offered,
    offeredPin: device.offeredPin,
    grant: revision.grant,
  });
}
export async function listBridgeDevices(db: Database, userId: string) {
  const ids = await db.orm
    .select({ id: bridgeDevices.id })
    .from(bridgeDevices)
    .where(eq(bridgeDevices.userId, userId))
    .limit(100);
  return Promise.all(ids.map((row) => getBridgeDevice(db, userId, row.id)));
}
async function limits(tx: Transaction, projectId: string, except?: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bridge-project:${projectId}`},0))`,
  );
  const rows = await tx
    .select({ id: bridgeDevices.id })
    .from(bridgeDevices)
    .where(and(eq(bridgeDevices.projectId, projectId), eq(bridgeDevices.enabled, true)));
  if (rows.filter((row) => row.id !== except).length >= 5) throw new BridgeError('BRIDGE_INVALID');
}
async function append(
  tx: Transaction,
  userId: string,
  deviceId: string,
  version: number,
  enabled: boolean,
  grant: BridgeGrant | null,
) {
  await tx.insert(bridgeDeviceVersions).values({
    id: workKey('bdv'),
    deviceId,
    version,
    enabled,
    grant: grant ? jsonValue(grant) : null,
  });
  await tx.insert(settingsHistory).values({
    namespace: `bridge:${deviceId}`,
    version,
    value: { enabled, grant: jsonValue(grant) },
    actorId: userId,
  });
  await tx.insert(auditLog).values({
    id: workKey('aud'),
    actorId: userId,
    action: 'bridge.configured',
    target: `${deviceId}:${version}`,
  });
  await tx.execute(sql`SELECT pg_notify('settings_changed',${`bridge:${deviceId}`})`);
  await tx.execute(sql`SELECT pg_notify('execution_changed',${deviceId})`);
}
export async function createBridgeDevice(
  db: Database,
  userId: string,
  input: unknown,
  resolve: McpSecretResolver,
) {
  const value = bridgeDeviceInputSchema.parse(input);
  await ownedProject(db, userId, value.projectId);
  if (valueHash(value) !== valueHash(secretRedactor.redact(value)))
    throw new BridgeError('BRIDGE_DENIED');
  const tokenHash = await resolve(value.secretRef as SecretReference, (token) => {
    if (token.length < 32 || token.length > 4096 || /\s/.test(token))
      throw new BridgeError('BRIDGE_INVALID');
    return Promise.resolve(hashToken(token));
  });
  const id = workKey('brg');
  await db.orm.transaction(async (tx) => {
    await limits(tx, value.projectId);
    if (
      !(
        await tx
          .insert(bridgeDevices)
          .values({ id, userId, ...value, tokenHash })
          .onConflictDoNothing()
          .returning()
      ).length
    )
      throw new BridgeError('BRIDGE_CONFLICT');
    await append(tx, userId, id, 1, true, null);
  });
  return getBridgeDevice(db, userId, id);
}
export function assertNarrower(grant: BridgeGrant, offered: BridgeManifest) {
  if (
    (offered.privateOnly && !grant.privateOnly) ||
    (grant.notifications && !offered.notifications) ||
    grant.commands.some((name) => !offered.commands.includes(name))
  )
    throw new BridgeError('BRIDGE_DENIED');
  for (const folder of grant.folders) {
    const local = offered.folders.find((entry) => entry.alias === folder.alias);
    if (
      !local ||
      (folder.mode === 'write' && local.mode !== 'write') ||
      (folder.delete && (!local.delete || folder.mode !== 'write'))
    )
      throw new BridgeError('BRIDGE_DENIED');
  }
}
export async function saveBridgeGrant(db: Database, userId: string, id: string, input: unknown) {
  const value = bridgeSaveSchema.parse(input);
  const { device } = await deviceRow(db, id, userId);
  if (!device.offered || device.offeredPin !== value.grant.pin)
    throw new BridgeError('BRIDGE_CHANGED');
  assertNarrower(value.grant, bridgeManifestSchema.parse(device.offered));
  await db.orm.transaction(async (tx) => {
    await limits(tx, device.projectId, id);
    const changed = await tx
      .update(bridgeDevices)
      .set({ version: value.expectedVersion + 1, enabled: true })
      .where(
        and(
          eq(bridgeDevices.id, id),
          eq(bridgeDevices.userId, userId),
          eq(bridgeDevices.version, value.expectedVersion),
          eq(bridgeDevices.offeredPin, value.grant.pin),
        ),
      )
      .returning();
    if (!changed.length) throw new BridgeError('BRIDGE_CONFLICT');
    await append(tx, userId, id, value.expectedVersion + 1, true, value.grant);
  });
  return getBridgeDevice(db, userId, id);
}
export async function controlBridgeDevice(
  db: Database,
  userId: string,
  id: string,
  input: unknown,
) {
  const value = integrationControlSchema.parse(input),
    current = await deviceRow(db, id, userId);
  await db.orm.transaction(async (tx) => {
    if (value.enabled) await limits(tx, current.device.projectId, id);
    const changed = await tx
      .update(bridgeDevices)
      .set({ enabled: value.enabled, version: value.expectedVersion + 1 })
      .where(
        and(
          eq(bridgeDevices.id, id),
          eq(bridgeDevices.userId, userId),
          eq(bridgeDevices.version, value.expectedVersion),
        ),
      )
      .returning();
    if (!changed.length || current.revision.version !== value.expectedVersion)
      throw new BridgeError('BRIDGE_CONFLICT');
    await append(
      tx,
      userId,
      id,
      value.expectedVersion + 1,
      value.enabled,
      current.revision.grant ? bridgeGrantSchema.parse(current.revision.grant) : null,
    );
  });
  return getBridgeDevice(db, userId, id);
}
export async function bridgeHistory(db: Database, userId: string, id: string) {
  await deviceRow(db, id, userId);
  return (
    await db.orm
      .select()
      .from(bridgeDeviceVersions)
      .where(eq(bridgeDeviceVersions.deviceId, id))
      .orderBy(desc(bridgeDeviceVersions.version))
      .limit(100)
  ).map((row) => ({
    version: row.version,
    enabled: row.enabled,
    grant: row.grant ? bridgeGrantSchema.parse(row.grant) : null,
  }));
}
export async function authenticateBridge(
  db: Database,
  id: unknown,
  authorization: unknown,
  resolve: McpSecretResolver,
) {
  if (
    !workId.safeParse(id).success ||
    typeof authorization !== 'string' ||
    !authorization.startsWith('Bearer ')
  )
    throw new BridgeError('BRIDGE_DENIED');
  const token = authorization.slice(7);
  if (token.length < 32 || token.length > 4096 || /\s/.test(token))
    throw new BridgeError('BRIDGE_DENIED');
  const { device } = await deviceRow(db, z.string().parse(id));
  if (
    !device.enabled ||
    !timingSafeEqual(Buffer.from(device.tokenHash, 'hex'), Buffer.from(hashToken(token), 'hex'))
  )
    throw new BridgeError('BRIDGE_DENIED');
  await resolve(device.secretRef as SecretReference, (expected) => {
    if (
      !timingSafeEqual(
        Buffer.from(hashToken(expected), 'hex'),
        Buffer.from(device.tokenHash, 'hex'),
      )
    )
      throw new BridgeError('BRIDGE_DENIED');
    secretRedactor.register(token);
    secretRedactor.register(authorization);
    return Promise.resolve();
  });
  return device;
}
export async function offerBridge(db: Database, id: string, connectionId: string, input: unknown) {
  const message = bridgeHelloSchema.parse(input);
  const changed = await db.orm
    .update(bridgeDevices)
    .set({
      offeredPin: message.pin,
      offered: jsonValue(message.manifest),
      connectionId,
      lastSeenAt: new Date(),
    })
    .where(
      and(
        eq(bridgeDevices.id, id),
        eq(bridgeDevices.enabled, true),
        sql`(${bridgeDevices.connectionId} IS NULL OR ${bridgeDevices.lastSeenAt}<now()-interval '20 seconds')`,
      ),
    )
    .returning();
  if (!changed.length) throw new BridgeError('BRIDGE_UNAVAILABLE');
  await db.orm
    .insert(auditLog)
    .values({ id: workKey('aud'), actorId: id, action: 'bridge.connected', target: message.pin });
  return changed[0]!;
}
export interface SelectedBridge {
  deviceId: string;
  revisionId: string;
  version: number;
  grant: BridgeGrant;
}
export async function selectedBridge(
  db: Database,
  runId: string,
  pin = false,
): Promise<SelectedBridge[]> {
  const context = await missionContext(db, runId);
  if (!context) throw new BridgeError('BRIDGE_DENIED');
  if (pin)
    await db.orm.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bridge-run:${runId}`},0))`,
      );
      if (
        (await tx.select().from(runBridgeSelections).where(eq(runBridgeSelections.runId, runId)))
          .length
      )
        return;
      let ids: unknown;
      if (context.run.parentRunId) {
        const [parent] = await tx
          .select()
          .from(runBridgeSelections)
          .where(eq(runBridgeSelections.runId, context.run.parentRunId));
        ids = parent?.revisionIds ?? [];
      } else {
        const rows = await tx
          .select({ id: bridgeDeviceVersions.id })
          .from(bridgeDeviceVersions)
          .innerJoin(
            bridgeDevices,
            and(
              eq(bridgeDevices.id, bridgeDeviceVersions.deviceId),
              eq(bridgeDevices.version, bridgeDeviceVersions.version),
            ),
          )
          .where(
            and(
              eq(bridgeDevices.userId, context.project.userId),
              eq(bridgeDevices.projectId, context.project.id),
              eq(bridgeDevices.enabled, true),
              sql`${bridgeDeviceVersions.grant} IS NOT NULL`,
            ),
          );
        ids = rows.map((row) => row.id);
      }
      await tx
        .insert(runBridgeSelections)
        .values({ runId, revisionIds: jsonValue(z.array(workId).max(5).parse(ids)) });
    });
  const [selection] = await db.orm
    .select()
    .from(runBridgeSelections)
    .where(eq(runBridgeSelections.runId, runId));
  const ids = z
    .array(workId)
    .max(5)
    .parse(selection?.revisionIds ?? []);
  if (!ids.length) return [];
  const rows = await db.orm
    .select({ device: bridgeDevices, revision: bridgeDeviceVersions })
    .from(bridgeDeviceVersions)
    .innerJoin(bridgeDevices, eq(bridgeDevices.id, bridgeDeviceVersions.deviceId))
    .where(inArray(bridgeDeviceVersions.id, ids));
  if (
    rows.length !== ids.length ||
    rows.some(
      (row) =>
        row.device.userId !== context.project.userId || row.device.projectId !== context.project.id,
    )
  )
    throw new BridgeError('BRIDGE_DENIED');
  return rows.map(({ device, revision }) => ({
    deviceId: device.id,
    revisionId: revision.id,
    version: revision.version,
    grant: bridgeGrantSchema.parse(revision.grant),
  }));
}
export async function assertBridgeCurrent(db: Database, selected: SelectedBridge) {
  const { device } = await deviceRow(db, selected.deviceId);
  if (!device.enabled || device.version !== selected.version)
    throw new BridgeError('BRIDGE_DENIED');
  if (device.offeredPin !== selected.grant.pin) throw new BridgeError('BRIDGE_CHANGED');
  return device;
}
export function assertBridgeScope(
  selected: SelectedBridge,
  agentId: string,
  toolName: string,
  input: unknown,
) {
  const tool = bridgeToolSchema.parse(toolName),
    args = bridgeInputs[tool].parse(input),
    grant = selected.grant;
  if (
    args.deviceId !== selected.deviceId ||
    !grant.agents.some((role) => role === agentId) ||
    !grant.tools.includes(tool)
  )
    throw new BridgeError('BRIDGE_DENIED');
  if ('folder' in args) {
    const folder = grant.folders.find((item) => item.alias === args.folder);
    if (
      !folder ||
      (!['local.fs.list', 'local.fs.read'].includes(tool) && folder.mode !== 'write') ||
      (tool === 'local.fs.delete' && !folder.delete)
    )
      throw new BridgeError('BRIDGE_DENIED');
  } else if ('command' in args) {
    if (!grant.commands.includes(args.command)) throw new BridgeError('BRIDGE_DENIED');
  } else if (!grant.notifications) throw new BridgeError('BRIDGE_DENIED');
  return args;
}
export async function bridgeActionAllowed(
  db: Database,
  runId: string,
  agentId: string,
  tool: string,
  args: unknown,
) {
  try {
    const { deviceId } = z.object({ deviceId: workId }).parse(args);
    const selected = (await selectedBridge(db, runId)).find((item) => item.deviceId === deviceId);
    if (!selected) return false;
    assertBridgeScope(selected, agentId, tool, args);
    await assertBridgeCurrent(db, selected);
    return true;
  } catch (error) {
    if (error instanceof BridgeError || error instanceof z.ZodError) return false;
    throw error;
  }
}
