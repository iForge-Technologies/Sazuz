import { and, eq, sql } from 'drizzle-orm';
import { McpError, externalExecutionSchema, type ExternalExecution } from '@sazuz/core/mcp';
import { missionLimitsSchema } from '@sazuz/core/missions';
import { BridgeError } from '@sazuz/core/bridge';
import { bridgeTools, executeBridge, selectedBridge, type BridgeHub } from '@sazuz/bridge';
import {
  approvals,
  executionNonces,
  getControl,
  isWorkerHealthy,
  missionContext,
  toolCalls,
  valueHash,
} from '@sazuz/db';
import { ActionStore, durableCheckpointSchema } from '@sazuz/runtime';
import { acceptedActionReview } from '@sazuz/orchestrator';
import { ToolRegistry, type RegisteredTool } from '@sazuz/tools';
import {
  executeMcp,
  mcpToolName,
  mcpTools,
  selectedMcp,
  verifyExternalSignature,
  type McpConnection,
} from '@sazuz/mcp';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';

export async function authorizeExternalAction(
  runtime: PhaseOne,
  message: ExternalExecution,
  tool: RegisteredTool,
) {
  const db = runtime.database,
    context = await missionContext(db, message.runId);
  if (
    !context ||
    context.run.workerId !== message.workerId ||
    context.run.claimKey !== message.claimKey ||
    context.run.status !== 'running' ||
    (await getControl(db)).paused ||
    (await runtime.vault.status()).locked
  )
    throw new McpError('MCP_DENIED');
  const state = durableCheckpointSchema.parse(context.run.checkpoint),
    loop = state.loop,
    call = loop.pendingCalls[loop.nextCall];
  if (
    !call ||
    call.name !== message.tool ||
    valueHash(call.args) !== valueHash(message.args) ||
    `${message.runId}:${loop.step}:${loop.nextCall}` !== message.callKey ||
    state.agentId !== context.run.agentId ||
    tool.name !== call.name
  )
    throw new McpError('MCP_DENIED');
  tool.parseArgs(message.args);
  const [intent] = await db.orm
    .select()
    .from(toolCalls)
    .where(and(eq(toolCalls.runId, message.runId), eq(toolCalls.idempotencyKey, message.callKey)));
  if (
    !intent ||
    !['intent', 'uncertain', 'retry_ready'].includes(intent.status) ||
    intent.toolName !== call.name ||
    intent.argsHash !== valueHash(call.args) ||
    intent.effect !== tool.effect
  )
    throw new McpError('MCP_DENIED');
  const deadline =
    Date.parse(loop.startedAt) +
    missionLimitsSchema.parse(context.run.limits).maxWallTimeSeconds * 1000;
  if (deadline <= Date.now()) throw new McpError('MCP_DENIED');
  if (!message.verify) {
    const store = new ActionStore({
      database: db,
      runId: context.run.id,
      userId: context.project.userId,
      projectId: context.project.id,
      projectCap: context.project.budgetUsd,
      getSettings: () => runtime.settings,
      tools: new ToolRegistry([tool]),
    });
    const decision = await store.policy(call, tool, loop);
    if (
      decision.action === 'deny' ||
      !(await acceptedActionReview(
        db,
        context.run.id,
        message.callKey,
        call,
        tool,
        runtime.settings,
      ))
    )
      throw new McpError('MCP_DENIED');
    if (decision.action === 'ask') {
      const [approval] = await db.orm
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.runId, context.run.id),
            eq(approvals.callKey, message.callKey),
            eq(approvals.kind, 'policy'),
            eq(approvals.status, 'approved'),
          ),
        );
      if (
        !approval ||
        approval.argsHash !== valueHash(call.args) ||
        approval.expiresAt.getTime() <= Date.now()
      )
        throw new McpError('MCP_DENIED');
    }
  }
  return { context, deadline, attempt: intent.attempt };
}
export function createExternalGateway(
  runtime: PhaseOne,
  connect: McpConnection,
  bridge: BridgeHub,
) {
  return async (input: unknown, signal = AbortSignal.timeout(50_000)) => {
    const message = externalExecutionSchema.parse(input),
      db = runtime.database;
    const context = await missionContext(db, message.runId);
    if (!context) throw new McpError('MCP_DENIED');
    if (message.tool.startsWith('local.')) {
      const selections = await selectedBridge(db, message.runId);
      const registry = new ToolRegistry(bridgeTools(selections, context.run.agentId));
      const tool = registry.get(message.tool);
      const authorized = await authorizeExternalAction(runtime, message, tool);
      const selection = selections.find((item) => item.deviceId === message.args.deviceId);
      if (!selection) throw new BridgeError('BRIDGE_DENIED');
      return executeBridge({
        db,
        hub: bridge,
        selection,
        runId: message.runId,
        projectId: context.project.id,
        agentId: context.run.agentId,
        tool: message.tool,
        args: message.args,
        key: message.callKey,
        attempt: authorized.attempt,
        verify: message.verify,
        deadline: authorized.deadline,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(1, authorized.deadline - Date.now())),
        ]),
        authorize: async () => {
          await authorizeExternalAction(runtime, message, tool);
        },
      });
    }
    const selected = await selectedMcp(db, message.runId);
    const registry = new ToolRegistry(mcpTools(selected, context.run.agentId));
    const tool = registry.get(message.tool);
    const authorized = await authorizeExternalAction(runtime, message, tool);
    const selection = selected.find((item) =>
      item.configuration.catalogue.tools.some(
        (entry) => mcpToolName(item.serverId, entry.name) === message.tool,
      ),
    );
    const remote = selection?.configuration.catalogue.tools.find(
      (entry) => mcpToolName(selection.serverId, entry.name) === message.tool,
    );
    if (!selection || !remote) throw new McpError('MCP_DENIED');
    return executeMcp({
      db,
      connect,
      selection,
      runId: message.runId,
      projectId: context.project.id,
      agentId: context.run.agentId,
      tool: remote.name,
      args: message.args,
      key: message.callKey,
      attempt: authorized.attempt,
      verify: message.verify,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, authorized.deadline - Date.now())),
      ]),
      authorize: async () => {
        await authorizeExternalAction(runtime, message, tool);
      },
    });
  };
}
export function registerExternalExecution(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  execute: ReturnType<typeof createExternalGateway>,
) {
  app.post('/internal/external-execution', async (request, reply) => {
    const message = externalExecutionSchema.parse(request.body);
    verifyExternalSignature(
      runtime.plumbing.operatorKey,
      message,
      request.headers['x-sazuz-worker-signature'],
    );
    if (!(await isWorkerHealthy(runtime.database, message.workerId)))
      throw new McpError('MCP_DENIED');
    await runtime.database.orm
      .delete(executionNonces)
      .where(sql`${executionNonces.expiresAt}<now()`);
    if (
      !(
        await runtime.database.orm
          .insert(executionNonces)
          .values({ nonce: message.nonce, expiresAt: new Date(message.expiresAt) })
          .onConflictDoNothing()
          .returning()
      ).length
    )
      throw new McpError('MCP_DENIED');
    const controller = new AbortController();
    const closed = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    reply.raw.once('close', closed);
    request.raw.socket?.setTimeout?.(55_000);
    let busy = false;
    const watch = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        const context = await missionContext(runtime.database, message.runId);
        if (
          !context ||
          context.run.claimKey !== message.claimKey ||
          context.run.status !== 'running' ||
          (await getControl(runtime.database)).paused
        )
          controller.abort();
      })()
        .catch(() => {
          controller.abort();
          runtime.database.logger.warn(
            { code: 'EXTERNAL_CONTROL_UNAVAILABLE' },
            'External call stopped.',
          );
        })
        .finally(() => {
          busy = false;
        });
    }, 500);
    try {
      return await execute(
        message,
        AbortSignal.any([controller.signal, AbortSignal.timeout(50_000)]),
      );
    } finally {
      clearInterval(watch);
      controller.abort();
      reply.raw.removeListener('close', closed);
    }
  });
}
