import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { McpError, type ExternalResult } from '@sazuz/core/mcp';
import { jsonValue, mcpCalls, valueHash, type Database } from '@sazuz/db';
import { secretRedactor } from '@sazuz/vault';
import { assertMcpCurrent, markMcpChanged, type SelectedMcp } from './store.js';
import { boundedJson, inputValidator } from './catalogue.js';
import type { McpConnection } from './client.js';

export async function executeMcp(options: {
  db: Database;
  connect: McpConnection;
  selection: SelectedMcp;
  runId: string;
  projectId: string;
  agentId: string;
  tool: string;
  args: unknown;
  key: string;
  attempt: number;
  verify: boolean;
  signal: AbortSignal;
  authorize(): Promise<void>;
}): Promise<ExternalResult> {
  const { db, selection } = options;
  const tool = selection.configuration.catalogue.tools.find((entry) => entry.name === options.tool);
  const permission = selection.configuration.permissions.find(
    (entry) => entry.tool === options.tool,
  );
  if (!tool || !permission?.enabled || !permission.agents.some((role) => role === options.agentId))
    throw new McpError('MCP_DENIED');
  const args = inputValidator(tool.inputSchema)(options.args);
  const hash = valueHash({ tool: tool.name, args });
  // Only the durable store advances attempts, after verified absence or explicit owner reconciliation.
  const attempt = z.number().int().positive().parse(options.attempt);
  const receiptKey = attempt === 1 ? options.key : `${options.key}:attempt:${attempt}`;
  await assertMcpCurrent(db, selection);
  const saved = async () => {
    const [row] = await db.orm.select().from(mcpCalls).where(eq(mcpCalls.key, receiptKey));
    if (
      row &&
      (row.runId !== options.runId ||
        row.revisionId !== selection.revisionId ||
        row.argsHash !== hash)
    )
      throw new McpError('MCP_DENIED');
    return row;
  };
  const previous = await saved();
  if (previous)
    return previous.status === 'done'
      ? { status: 'done', output: z.json().parse(previous.result) }
      : { status: 'unknown' };
  if (options.verify) return { status: 'not_done' };
  const lease = await db.pool.connect();
  let locked = false;
  try {
    locked =
      (
        await lease.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1,7)) AS locked',
          [options.key],
        )
      ).rows[0]?.locked ?? false;
    if (!locked) return { status: 'unknown' };
    if (await saved()) return { status: 'unknown' };
    return await options.connect(
      selection.configuration.transport,
      { projectId: options.projectId, agentId: options.agentId, signal: options.signal },
      async (client, catalogue) => {
        if (catalogue.sha256 !== selection.configuration.catalogue.sha256) {
          await markMcpChanged(db, selection);
          throw new McpError('MCP_CHANGED');
        }
        await assertMcpCurrent(db, selection);
        await options.authorize();
        if (options.signal.aborted) throw new McpError('MCP_DENIED');
        await db.orm.insert(mcpCalls).values({
          key: receiptKey,
          runId: options.runId,
          revisionId: selection.revisionId,
          argsHash: hash,
        });
        // No retry or resumption request is issued to an external server after this boundary.
        const response = await client.callTool(
          { name: tool.name, arguments: args, _meta: { 'sazuz/idempotency-key': options.key } },
          undefined,
          { signal: options.signal, timeout: 20_000 },
        );
        boundedJson(response, 65_536, 20);
        const output = z.json().parse(secretRedactor.redact(response));
        await db.orm
          .update(mcpCalls)
          .set({ status: 'done', result: jsonValue(output) })
          .where(and(eq(mcpCalls.key, receiptKey), eq(mcpCalls.argsHash, hash)));
        return { status: 'done', output };
      },
    );
  } finally {
    let reusable = false;
    try {
      if (locked)
        await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,7))', [options.key]);
      reusable = true;
    } finally {
      lease.release(!reusable);
    }
  }
}
