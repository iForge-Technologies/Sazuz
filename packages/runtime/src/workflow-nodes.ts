import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  runs,
  runAgentVersions,
  workflowRuns,
  workflowNodeRuns,
  enqueueRun,
  workKey,
  jsonValue,
  valueHash,
  type Database,
  type Transaction,
  type missionContext,
} from '@sazuz/db';
import { runAgent as pinnedAgent } from '@sazuz/orchestrator';
import {
  WorkflowError,
  workflowNodeExecutionSchema,
  type WorkflowNode,
  type WorkflowDefinition,
} from '@sazuz/core/workflows';
import { missionLimitsSchema, type AgentRole } from '@sazuz/core/missions';
import { renderToolOutput } from '@sazuz/tools';
import { safeData, snapshotKey } from '@sazuz/workflows';
import { durableCheckpointSchema } from './durable-contracts.js';
import { newCheckpoint, SYSTEM_RULES } from './loop.js';

export type WorkflowContext = NonNullable<Awaited<ReturnType<typeof missionContext>>>;
export type WorkflowRow = typeof workflowRuns.$inferSelect;
export type NodeRow = typeof workflowNodeRuns.$inferSelect;
export function workflowAgent(node: WorkflowNode): AgentRole {
  return 'agent' in node.action
    ? node.action.agent
    : node.action.kind === 'classify'
      ? 'monitor'
      : 'cos';
}
export const workflowExecutionRoles = (snapshot: Record<string, WorkflowDefinition>) =>
  new Set(
    Object.values(snapshot).flatMap((definition) =>
      definition.nodes
        .filter((node) =>
          ['tool', 'agent', 'skill', 'classify', 'approval', 'notify'].includes(node.action.kind),
        )
        .map(workflowAgent),
    ),
  );
export async function inheritWorkflowAuthority(tx: Transaction, parentId: string, childId: string) {
  const selections = await tx
    .select()
    .from(runAgentVersions)
    .where(eq(runAgentVersions.runId, parentId));
  if (!selections.length) throw new WorkflowError('WORKFLOW_INVALID');
  await tx.insert(runAgentVersions).values(
    selections.map((row) => ({
      runId: childId,
      role: row.role,
      revisionId: row.revisionId,
      connectorBindings: row.connectorBindings,
    })),
  );
}
export async function dispatchWorkflowNode(options: {
  database: Database;
  context: WorkflowContext;
  workflow: WorkflowRow;
  row: NodeRow;
  node: WorkflowNode;
}) {
  const { database, context, workflow, row, node } = options;
  const action = node.action,
    agent = workflowAgent(node);
  const definition = await pinnedAgent(database, context.project.userId, context.run.id, agent);
  const input = safeData(row.input),
    limits = missionLimitsSchema.parse(context.run.limits);
  const toolsOnly = ['tool', 'approval', 'notify'].includes(action.kind);
  const calls =
    action.kind === 'tool'
      ? [{ id: 'workflow_action', name: action.tool, args: input }]
      : action.kind === 'approval'
        ? [
            {
              id: 'workflow_checkpoint',
              name: 'workflow.checkpoint',
              args: { message: action.message },
            },
          ]
        : action.kind === 'notify'
          ? [{ id: 'workflow_notification', name: 'workflow.notify', args: input }]
          : action.kind === 'skill'
            ? [
                {
                  id: 'workflow_skill',
                  name: 'skills.load',
                  args: { name: action.name, revision: action.revision },
                },
              ]
            : [];
  const outputSchema =
    action.kind === 'agent' || action.kind === 'skill'
      ? action.outputSchema
      : action.kind === 'classify'
        ? {
            type: 'object',
            properties: { branch: { type: 'string', enum: action.branches } },
            required: ['branch'],
            additionalProperties: false,
          }
        : null;
  const prompt = 'prompt' in action ? action.prompt : node.label;
  const goal = `${prompt}\nWorkflow input:\n${renderToolOutput({ output: input, untrusted: true })}${outputSchema ? `\nReturn a final JSON object matching this schema: ${JSON.stringify(outputSchema)}` : ''}`;
  if (goal.length > 16000) throw new WorkflowError('WORKFLOW_LIMIT');
  const startedAt = workflow.startedAt.toISOString();
  const deadline = new Date(
    Math.min(
      workflow.startedAt.getTime() + limits.maxWallTimeSeconds * 1000,
      row.startedAt!.getTime() + node.retry.timeoutSeconds * 1000,
    ),
  ).toISOString();
  const loop = newCheckpoint(
    [
      { role: 'system', content: `${SYSTEM_RULES}\n${definition.instructions}` },
      { role: 'user', content: goal },
    ],
    row.tainted,
  );
  loop.startedAt = startedAt;
  loop.privateOnly = row.privateOnly;
  if (calls.length) {
    loop.pendingCalls = calls;
    loop.step = 1;
    loop.messages.push({
      role: 'assistant',
      content: 'Execute the reviewed workflow node.',
      toolCalls: calls,
    });
  }
  const checkpoint = durableCheckpointSchema.parse({
    version: 1,
    loop,
    phase: 'direct',
    agentId: agent,
    plan: null,
    taskIndex: 0,
    results: [],
  });
  const execution = workflowNodeExecutionSchema.parse({
    workflowRunId: context.run.id,
    nodeId: row.id,
    action,
    goal,
    input,
    startedAt,
    deadline,
    toolsOnly,
    privateOnly: row.privateOnly,
    modelFree: workflow.modelFree,
    test: workflow.test,
  });
  await database.orm.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(workflowNodeRuns)
      .where(eq(workflowNodeRuns.id, row.id))
      .for('update');
    if (current?.runId || current?.status !== 'running') return;
    const id = workKey('run');
    await tx.insert(runs).values({
      id,
      missionId: context.mission.id,
      parentRunId: context.run.id,
      agentId: agent,
      checkpoint: jsonValue(checkpoint),
      workflowNode: jsonValue(execution),
      limits,
      tainted: row.tainted,
      step: loop.step,
    });
    await inheritWorkflowAuthority(tx, context.run.id, id);
    await tx.update(workflowNodeRuns).set({ runId: id }).where(eq(workflowNodeRuns.id, row.id));
    await enqueueRun(tx, id);
  });
}

export async function dispatchSubWorkflow(options: {
  database: Database;
  context: WorkflowContext;
  workflow: WorkflowRow;
  row: NodeRow;
  node: WorkflowNode;
  input: unknown;
  index: number;
}) {
  const { database, context, workflow, row, node, index } = options;
  const action = node.action;
  if (action.kind !== 'map' && action.kind !== 'workflow')
    throw new WorkflowError('WORKFLOW_INVALID');
  const snapshot = z.record(z.string(), z.unknown()).parse(workflow.snapshot);
  if (!snapshot[snapshotKey(action.workflowId, action.revision)])
    throw new WorkflowError('WORKFLOW_INVALID');
  const input = safeData(options.input);
  await database.orm.transaction(async (tx) => {
    const existing = await tx
      .select({ id: workflowRuns.runId })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.parentNodeId, row.id), eq(workflowRuns.itemIndex, index)));
    if (existing.length) return;
    const id = workKey('run');
    const limits = missionLimitsSchema.parse(context.run.limits);
    limits.maxWallTimeSeconds = Math.min(
      limits.maxWallTimeSeconds,
      Math.max(
        1,
        Math.floor(
          (row.startedAt!.getTime() +
            node.retry.timeoutSeconds * 1000 -
            workflow.startedAt.getTime()) /
            1000,
        ),
      ),
    );
    await tx.insert(runs).values({
      id,
      missionId: context.mission.id,
      parentRunId: context.run.id,
      agentId: workflow.inheritedAuthority ? context.run.agentId : 'cos',
      limits,
      tainted: row.tainted,
    });
    await inheritWorkflowAuthority(tx, context.run.id, id);
    await tx.insert(workflowRuns).values({
      runId: id,
      workflowId: action.workflowId,
      revision: action.revision,
      snapshot: workflow.snapshot,
      inputHash: valueHash(input),
      input,
      parentNodeId: row.id,
      itemIndex: index,
      test: workflow.test,
      modelFree: workflow.modelFree,
      inheritedAuthority: workflow.inheritedAuthority,
      tainted: row.tainted,
      privateOnly: row.privateOnly,
      startedAt: workflow.startedAt,
    });
    await enqueueRun(tx, id);
  });
}
