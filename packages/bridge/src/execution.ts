import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { BridgeError, bridgeRequestSchema } from '@sazuz/core/bridge';
import { externalResultSchema, type ExternalResult } from '@sazuz/core/mcp';
import { bridgeCalls, jsonValue, valueHash, type Database } from '@sazuz/db';
import { secretRedactor } from '@sazuz/vault';
import { assertBridgeCurrent, assertBridgeScope, type SelectedBridge } from './store.js';
import type { BridgeHub } from './server.js';

export async function executeBridge(options: {
  db: Database;
  hub: BridgeHub;
  selection: SelectedBridge;
  runId: string;
  projectId: string;
  agentId: string;
  tool: string;
  args: unknown;
  key: string;
  attempt: number;
  verify: boolean;
  deadline: number;
  signal: AbortSignal;
  authorize(): Promise<void>;
}): Promise<ExternalResult> {
  const { db, selection } = options;
  const args = assertBridgeScope(selection, options.agentId, options.tool, options.args);
  const hash = valueHash({ tool: options.tool, args }),
    attempt = z.number().int().positive().parse(options.attempt);
  const key = attempt === 1 ? options.key : `${options.key}:attempt:${attempt}`;
  await assertBridgeCurrent(db, selection);
  const saved = async () => {
    const [row] = await db.orm.select().from(bridgeCalls).where(eq(bridgeCalls.key, key));
    if (
      row &&
      (row.runId !== options.runId ||
        row.argsHash !== hash ||
        row.revisionId !== selection.revisionId)
    )
      throw new BridgeError('BRIDGE_DENIED');
    return row;
  };
  const previous = await saved();
  if (previous?.status === 'done')
    return { status: 'done', output: z.json().parse(previous.result) };
  if (options.verify && !previous) return { status: 'not_done' };
  const lease = await db.pool.connect();
  let locked = false;
  try {
    locked =
      (
        await lease.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1,8)) AS locked',
          [key],
        )
      ).rows[0]?.locked ?? false;
    if (!locked) return { status: 'unknown' };
    const receipt = await saved();
    if (receipt?.status === 'done')
      return { status: 'done', output: z.json().parse(receipt.result) };
    if (receipt && !options.verify) return { status: 'unknown' };
    await assertBridgeCurrent(db, selection);
    await options.authorize();
    if (options.signal.aborted) throw new BridgeError('BRIDGE_DENIED');
    if (!receipt)
      await db.orm
        .insert(bridgeCalls)
        .values({ key, runId: options.runId, revisionId: selection.revisionId, argsHash: hash });
    const request = bridgeRequestSchema.parse({
      type: 'request',
      id: randomUUID(),
      deviceId: selection.deviceId,
      projectId: options.projectId,
      agentId: options.agentId,
      key,
      pin: selection.grant.pin,
      version: selection.version,
      tool: options.tool,
      args,
      deadline: Math.min(options.deadline, Date.now() + 30000),
      verify: options.verify,
    });
    const response = externalResultSchema.parse(
      await options.hub.dispatch(request, options.signal),
    );
    if (response.status !== 'done') return response;
    const output = z.json().parse(secretRedactor.redact(response.output));
    if (Buffer.byteLength(JSON.stringify(output)) > 12000) throw new BridgeError('BRIDGE_INVALID');
    await db.orm
      .update(bridgeCalls)
      .set({ status: 'done', result: jsonValue(output) })
      .where(eq(bridgeCalls.key, key));
    return { status: 'done', output };
  } finally {
    let reusable = false;
    try {
      if (locked) await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,8))', [key]);
      reusable = true;
    } finally {
      lease.release(!reusable);
    }
  }
}
