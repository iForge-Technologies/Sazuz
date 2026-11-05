import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  mcpClientInputSchema,
  mcpClientSchema,
  integrationControlSchema,
  McpError,
} from '@sazuz/core/mcp';
import { auditLog, mcpClients, settingsHistory, workKey, type Database } from '@sazuz/db';
import { secretRedactor, type SecretReference } from '@sazuz/vault';
import { ownedProject } from './store.js';

export type McpSecretResolver = <T>(
  reference: SecretReference,
  consume: (secret: string) => Promise<T>,
) => Promise<T>;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const publicClient = (row: typeof mcpClients.$inferSelect) =>
  mcpClientSchema.parse({
    id: row.id,
    name: row.name,
    projectId: row.projectId,
    secretRef: row.secretRef,
    tools: row.tools,
    allowPrivate: row.allowPrivate,
    enabled: row.enabled,
    version: row.version,
  });
export async function listMcpClients(db: Database, userId: string) {
  return (
    await db.orm.select().from(mcpClients).where(eq(mcpClients.userId, userId)).limit(100)
  ).map(publicClient);
}
export async function saveMcpClient(
  db: Database,
  userId: string,
  input: unknown,
  resolve: McpSecretResolver,
) {
  const value = mcpClientInputSchema.parse(input);
  await ownedProject(db, userId, value.projectId);
  if (JSON.stringify(secretRedactor.redact(value)) !== JSON.stringify(value))
    throw new McpError('MCP_DENIED');
  const tokenHash = await resolve(value.secretRef as SecretReference, (token) => {
    if (token.length < 32 || token.length > 4096 || /\s/.test(token))
      throw new McpError('MCP_INVALID');
    return Promise.resolve(digest(token));
  });
  const id = workKey('mct');
  await db.orm.transaction(async (tx) => {
    const rows = await tx
      .insert(mcpClients)
      .values({ id, userId, ...value, tokenHash })
      .onConflictDoNothing()
      .returning();
    if (!rows.length) throw new McpError('MCP_CONFLICT');
    await tx.insert(settingsHistory).values({
      namespace: `mcp-client:${id}`,
      version: 1,
      value: { ...value, enabled: true },
      actorId: userId,
    });
    await tx
      .insert(auditLog)
      .values({ id: workKey('aud'), actorId: userId, action: 'mcp.client.created', target: id });
    await tx.execute(sql`SELECT pg_notify('settings_changed',${`mcp-client:${id}`})`);
  });
  return mcpClientSchema.parse({ id, ...value, enabled: true, version: 1 });
}
export async function controlMcpClient(db: Database, userId: string, id: string, input: unknown) {
  const value = integrationControlSchema.parse(input);
  return db.orm.transaction(async (tx) => {
    const [row] = await tx
      .update(mcpClients)
      .set({ enabled: value.enabled, version: value.expectedVersion + 1 })
      .where(
        and(
          eq(mcpClients.id, id),
          eq(mcpClients.userId, userId),
          eq(mcpClients.version, value.expectedVersion),
        ),
      )
      .returning();
    if (!row) throw new McpError('MCP_CONFLICT');
    const result = publicClient(row);
    await tx.insert(settingsHistory).values({
      namespace: `mcp-client:${id}`,
      version: row.version,
      value: result,
      actorId: userId,
    });
    await tx.insert(auditLog).values({
      id: workKey('aud'),
      actorId: userId,
      action: value.enabled ? 'mcp.client.enabled' : 'mcp.client.revoked',
      target: id,
    });
    await tx.execute(sql`SELECT pg_notify('settings_changed',${`mcp-client:${id}`})`);
    return result;
  });
}
export type AuthenticatedMcpClient = z.infer<typeof mcpClientSchema> & { userId: string };
export async function authenticateMcpClient(
  db: Database,
  authorization: unknown,
  resolve: McpSecretResolver,
): Promise<AuthenticatedMcpClient> {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
    throw new McpError('MCP_DENIED');
  const token = authorization.slice(7);
  if (token.length < 32 || token.length > 4096 || /\s/.test(token))
    throw new McpError('MCP_DENIED');
  const hash = digest(token);
  const [row] = await db.orm
    .select()
    .from(mcpClients)
    .where(and(eq(mcpClients.tokenHash, hash), eq(mcpClients.enabled, true)));
  if (!row) throw new McpError('MCP_DENIED');
  await resolve(row.secretRef as SecretReference, (expected) => {
    if (!timingSafeEqual(Buffer.from(digest(expected), 'hex'), Buffer.from(hash, 'hex')))
      throw new McpError('MCP_DENIED');
    secretRedactor.register(token);
    secretRedactor.register(authorization);
    return Promise.resolve();
  });
  const project = await ownedProject(db, row.userId, row.projectId);
  if (project.privacy === 'private' && !row.allowPrivate) throw new McpError('MCP_DENIED');
  return { ...publicClient(row), userId: row.userId };
}
