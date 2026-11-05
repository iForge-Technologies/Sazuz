import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  workflowNodeRuns,
  workflowRuns,
  workflowEvents,
  runs,
  toolCalls,
  runSteps,
  messages,
  workKey,
  missionAllowance,
  type Database,
  type Transaction,
} from '@sazuz/db';
import { pinAgent, hasPinnedAgent } from '@sazuz/orchestrator';
import { WorkflowError, workflowSnapshotSchema, type WorkflowNode } from '@sazuz/core/workflows';
import type { SettingsDocument } from '@sazuz/config/settings';
import { evaluateExpression, outputValidator, safeData, snapshotKey } from '@sazuz/workflows';
import { durableCheckpointSchema, type DurableCheckpoint } from './durable-contracts.js';
import { RunSuspension } from './contracts.js';
import {
  dispatchSubWorkflow,
  dispatchWorkflowNode,
  workflowExecutionRoles,
  type NodeRow,
  type WorkflowRow,
  type WorkflowContext,
} from './workflow-nodes.js';

const terminal = (status: string) => ['completed', 'skipped', 'mocked'].includes(status);
export async function coordinateWorkflow(options: {
  database: Database;
  context: WorkflowContext;
  workflow: WorkflowRow;
  state: DurableCheckpoint;
  getSettings: () => SettingsDocument;
  signal: AbortSignal;
  acquireSpend(): Promise<void>;
  releaseSpend(): Promise<void>;
  remaining(): Promise<number>;
  persist(tx: Transaction): Promise<void>;
  reviewOutput(candidate: string): Promise<void>;
}) {
  const { database, context, workflow, state, signal } = options;
  const snapshot = workflowSnapshotSchema.parse(workflow.snapshot);
  const graph = snapshot[snapshotKey(workflow.workflowId, workflow.revision)];
  if (!graph) throw new WorkflowError('WORKFLOW_INVALID');
  if (workflow.modelFree && context.project.reviewMode !== 'off')
    throw new WorkflowError('WORKFLOW_MODEL_FREE');
  state.phase = 'workflow';
  state.graphWaiting = false;
  state.loop.startedAt = workflow.startedAt.toISOString();
  state.loop.tainted ||= workflow.tainted;
  state.loop.privateOnly ||= workflow.privateOnly;
  const roles = workflowExecutionRoles(snapshot);
  for (const role of roles) {
    if (workflow.inheritedAuthority && !(await hasPinnedAgent(database, context.run.id, role)))
      throw new WorkflowError('WORKFLOW_INVALID');
    await pinAgent(
      database,
      context.project.userId,
      context.run.id,
      role,
      options.getSettings().connectors.value.accounts,
    );
  }
  for (const node of graph.nodes)
    await database.orm
      .insert(workflowNodeRuns)
      .values({ id: workKey('wfn'), workflowRunId: context.run.id, nodeKey: node.id })
      .onConflictDoNothing();

  const latest = async () => {
    const rows = await database.orm
      .select()
      .from(workflowNodeRuns)
      .where(eq(workflowNodeRuns.workflowRunId, context.run.id))
      .orderBy(workflowNodeRuns.attempt);
    return new Map(rows.map((row) => [row.nodeKey, row]));
  };
  async function finish(
    row: NodeRow,
    output: unknown,
    branch: string | null = null,
    status = 'completed',
  ) {
    const clean = safeData(output);
    await database.orm
      .update(workflowNodeRuns)
      .set({ status, output: clean, branch, reason: null })
      .where(eq(workflowNodeRuns.id, row.id));
  }
  async function reserve(
    row: NodeRow,
    node: WorkflowNode,
    input: unknown,
    tainted: boolean,
    privateOnly: boolean,
  ) {
    await options.acquireSpend();
    try {
      if (
        (await missionAllowance(database, context.mission.id)).steps <= 0 ||
        (await options.remaining()) < 0
      )
        throw new RunSuspension('budget_exceeded', 'The shared workflow allowance was reached.');
      const clean = safeData(input);
      return await database.orm.transaction(async (tx) => {
        state.loop.step++;
        const [saved] = await tx
          .update(workflowNodeRuns)
          .set({
            status: 'running',
            input: clean,
            startedAt: new Date(),
            tainted,
            privateOnly,
            pinned: workflow.test && node.pin !== null,
          })
          .where(eq(workflowNodeRuns.id, row.id))
          .returning();
        await options.persist(tx);
        return saved!;
      });
    } finally {
      await options.releaseSpend();
    }
  }
  async function synchronize(row: NodeRow, node: WorkflowNode) {
    if (!row.runId || terminal(row.status)) return;
    const [child] = await database.orm.select().from(runs).where(eq(runs.id, row.runId));
    if (!child) throw new WorkflowError('WORKFLOW_INVALID');
    const checkpoint = durableCheckpointSchema.safeParse(child.checkpoint).data;
    const tainted = row.tainted || child.tainted,
      privateOnly = row.privateOnly || (checkpoint?.loop.privateOnly ?? false);
    state.loop.tainted ||= tainted;
    state.loop.privateOnly ||= privateOnly;
    await database.orm
      .update(workflowNodeRuns)
      .set({
        ...(child.status === 'completed' ? {} : { status: child.status }),
        reason: child.reason,
        tainted,
        privateOnly,
      })
      .where(eq(workflowNodeRuns.id, row.id));
    if (child.status === 'completed') {
      const output = checkpoint?.workflowOutput;
      if (output === undefined) throw new WorkflowError('WORKFLOW_INVALID');
      const branch =
        node.action.kind === 'classify'
          ? z.object({ branch: z.string() }).parse(output).branch
          : null;
      await finish(row, output, branch);
    } else if (child.status === 'failed') {
      const sideEffects = await database.orm
        .select({ id: toolCalls.id })
        .from(toolCalls)
        .where(and(eq(toolCalls.runId, child.id), sql`${toolCalls.effect} <> 'read'`))
        .limit(1);
      if (!sideEffects.length && row.attempt < node.retry.attempts) {
        await database.orm
          .insert(workflowNodeRuns)
          .values({
            id: workKey('wfn'),
            workflowRunId: context.run.id,
            nodeKey: node.id,
            attempt: row.attempt + 1,
            readyAt: new Date(Date.now() + node.retry.delaySeconds * 1000),
          })
          .onConflictDoNothing();
      } else
        throw new RunSuspension(
          'failed',
          `Workflow node ${node.label} failed. Review its evidence; no uncertain effect was repeated.`,
        );
    } else if (['paused', 'cancelled', 'budget_exceeded'].includes(child.status))
      throw new RunSuspension(
        child.status === 'budget_exceeded' ? 'budget_exceeded' : 'paused',
        `Workflow node ${node.label} needs attention. Open its run controls.`,
      );
  }
  async function subWork(row: NodeRow, node: WorkflowNode) {
    const action = node.action;
    if (action.kind !== 'workflow' && action.kind !== 'map') return;
    const data =
      action.kind === 'map'
        ? z.object({ items: z.array(z.json()).max(50), context: z.json() }).parse(row.input)
        : null;
    const inputs = data
      ? data.items.map((item, index) => ({ item, index, context: data.context }))
      : [row.input];
    const children = await database.orm
      .select({ workflow: workflowRuns, run: runs })
      .from(workflowRuns)
      .innerJoin(runs, eq(runs.id, workflowRuns.runId))
      .where(eq(workflowRuns.parentNodeId, row.id))
      .orderBy(workflowRuns.itemIndex);
    const failed = children.find((child) =>
      ['failed', 'paused', 'cancelled', 'budget_exceeded'].includes(child.run.status),
    );
    if (failed)
      throw new RunSuspension(
        failed.run.status === 'budget_exceeded' ? 'budget_exceeded' : 'paused',
        `Sub-workflow in ${node.label} needs attention.`,
      );
    if (
      children.length === inputs.length &&
      children.every((child) => child.run.status === 'completed')
    ) {
      const tainted = row.tainted || children.some((child) => child.workflow.tainted);
      const privateOnly = row.privateOnly || children.some((child) => child.workflow.privateOnly);
      state.loop.tainted ||= tainted;
      state.loop.privateOnly ||= privateOnly;
      await database.orm
        .update(workflowNodeRuns)
        .set({ tainted, privateOnly })
        .where(eq(workflowNodeRuns.id, row.id));
      await finish(
        row,
        data ? children.map((child) => child.workflow.output) : children[0]!.workflow.output,
      );
      return;
    }
    const active = children.filter((child) => child.run.status !== 'completed').length;
    const slots = (action.kind === 'map' ? action.concurrency : 1) - active;
    for (
      let index = children.length;
      index < Math.min(inputs.length, children.length + slots);
      index++
    )
      await dispatchSubWorkflow({
        database,
        context,
        workflow,
        row,
        node,
        input: inputs[index],
        index,
      });
  }

  for (let pass = 0; pass < 65; pass++) {
    if (signal.aborted) throw new RunSuspension('paused', 'Workflow execution was stopped.');
    let rows = await latest();
    for (const node of graph.nodes) await synchronize(rows.get(node.id)!, node);
    rows = await latest();
    for (const node of graph.nodes) {
      const row = rows.get(node.id)!;
      if (
        row.status === 'running' &&
        (node.action.kind === 'workflow' || node.action.kind === 'map')
      )
        await subWork(row, node);
    }
    rows = await latest();
    if ([...rows.values()].every((row) => terminal(row.status))) {
      const output = safeData(
        Object.fromEntries(
          graph.nodes
            .filter((node) => !graph.edges.some((edge) => edge.from === node.id))
            .map((node) => [node.id, rows.get(node.id)!.output]),
        ),
      );
      const text = `Workflow ${graph.name} completed.\n${JSON.stringify(output)}`;
      await options.reviewOutput(text);
      state.phase = 'done';
      state.graphWaiting = false;
      state.workflowOutput = output;
      state.loop.status = 'completed';
      await database.orm.transaction(async (tx) => {
        await tx
          .update(workflowRuns)
          .set({ output, tainted: state.loop.tainted, privateOnly: state.loop.privateOnly })
          .where(eq(workflowRuns.runId, context.run.id));
        await tx
          .insert(runSteps)
          .values({
            id: workKey('step'),
            runId: context.run.id,
            eventKey: 'workflow:completed',
            ordinal: state.loop.step * 1000 + 999,
            agentId: 'cos',
            kind: 'assistant',
            content: text,
          })
          .onConflictDoNothing();
        if (!context.run.parentRunId)
          await tx
            .insert(messages)
            .values({
              id: workKey('msg'),
              threadId: context.mission.threadId,
              role: 'assistant',
              content: text,
              trust: state.loop.tainted ? 'untrusted' : 'trusted',
              requestId: `${context.run.id}:workflow`,
            })
            .onConflictDoNothing();
        await options.persist(tx);
      });
      return;
    }
    let progressed = false;
    let active = [...rows.values()].filter((row) =>
      ['running', 'queued', 'waiting_approval'].includes(row.status),
    ).length;
    for (const node of graph.nodes) {
      let row = rows.get(node.id)!;
      if (row.runId || terminal(row.status) || (row.readyAt && row.readyAt > new Date())) continue;
      try {
        if (row.status === 'pending') {
          if (active >= graph.concurrency) continue;
          const incoming = graph.edges.filter((edge) => edge.to === node.id);
          if (incoming.some((edge) => !terminal(rows.get(edge.from)!.status))) continue;
          const accepted = incoming.filter(
            (edge) =>
              rows.get(edge.from)!.status !== 'skipped' &&
              (!edge.branch || rows.get(edge.from)!.branch === edge.branch),
          );
          if (incoming.length && !accepted.length) {
            await finish(row, null, null, 'skipped');
            progressed = true;
            continue;
          }
          const tainted =
            state.loop.tainted || accepted.some((edge) => rows.get(edge.from)!.tainted);
          const privateOnly =
            state.loop.privateOnly || accepted.some((edge) => rows.get(edge.from)!.privateOnly);
          const outputs = Object.fromEntries(
            [...rows]
              .filter(([, item]) => terminal(item.status))
              .map(([key, item]) => [key, item.output]),
          );
          let input =
            node.action.kind === 'trigger'
              ? workflow.input
              : await evaluateExpression(node.input, workflow.input, outputs, signal);
          if (node.action.kind === 'map') {
            const items = z
              .array(z.json())
              .max(50)
              .parse(await evaluateExpression(node.action.items, input, outputs, signal));
            input = { items, context: safeData(input) };
          }
          row = await reserve(row, node, input, tainted, privateOnly);
          progressed = true;
          active++;
        }
        if (row.status !== 'running') continue;
        if (Date.now() >= row.startedAt!.getTime() + node.retry.timeoutSeconds * 1000)
          throw new RunSuspension('failed', `Workflow node ${node.label} reached its timeout.`);
        if (row.pinned) {
          const action = node.action;
          const branch =
            action.kind === 'condition'
              ? String(z.boolean().parse(node.pin))
              : action.kind === 'classify'
                ? z
                    .object({ branch: z.enum(action.branches as [string, ...string[]]) })
                    .parse(node.pin).branch
                : null;
          if (action.kind === 'agent' || action.kind === 'skill')
            outputValidator(action.outputSchema)(node.pin);
          await finish(row, node.pin, branch, 'mocked');
          progressed = true;
          active--;
          continue;
        }
        const action = node.action;
        if (['tool', 'agent', 'skill', 'classify', 'approval', 'notify'].includes(action.kind)) {
          await options.acquireSpend();
          try {
            if (
              (await missionAllowance(database, context.mission.id)).steps < 1 ||
              (await options.remaining()) < 0
            )
              throw new RunSuspension(
                'budget_exceeded',
                'The shared workflow allowance was reached.',
              );
            await dispatchWorkflowNode({ database, context, workflow, row, node });
          } finally {
            await options.releaseSpend();
          }
        } else if (action.kind === 'workflow' || action.kind === 'map') {
          await subWork(row, node);
        } else if (action.kind === 'wait') {
          if (action.until.kind === 'event') {
            const eventName = action.until.name;
            const [event] = await database.orm
              .select()
              .from(workflowEvents)
              .where(
                and(eq(workflowEvents.runId, context.run.id), eq(workflowEvents.name, eventName)),
              )
              .orderBy(desc(workflowEvents.createdAt))
              .limit(1);
            if (event) {
              await finish(row, event.data);
              state.loop.tainted = true;
              progressed = true;
              active--;
            }
          } else {
            const at =
              action.until.kind === 'time'
                ? new Date(action.until.at).getTime()
                : row.startedAt!.getTime() + action.until.seconds * 1000;
            if (Date.now() >= at) {
              await finish(row, row.input);
              progressed = true;
              active--;
            }
          }
        } else {
          const output =
            action.kind === 'condition' || action.kind === 'transform'
              ? await evaluateExpression(action.expression, row.input, {}, signal)
              : row.input;
          const branch = action.kind === 'condition' ? String(z.boolean().parse(output)) : null;
          await finish(row, output, branch);
          progressed = true;
          active--;
        }
      } catch (error) {
        if (error instanceof RunSuspension && error.status !== 'failed') throw error;
        if (!['trigger', 'condition', 'transform', 'parallel', 'wait'].includes(node.action.kind))
          throw error;
        if (!row.startedAt)
          row = await reserve(row, node, null, state.loop.tainted, state.loop.privateOnly);
        await database.orm
          .update(workflowNodeRuns)
          .set({ status: 'failed', reason: 'Node evaluation failed or reached its timeout.' })
          .where(eq(workflowNodeRuns.id, row.id));
        if (row.attempt >= node.retry.attempts)
          throw new RunSuspension(
            'failed',
            `Workflow node ${node.label} failed. Inspect its inputs, expression and timeout.`,
          );
        await database.orm
          .insert(workflowNodeRuns)
          .values({
            id: workKey('wfn'),
            workflowRunId: context.run.id,
            nodeKey: node.id,
            attempt: row.attempt + 1,
            readyAt: new Date(Date.now() + node.retry.delaySeconds * 1000),
          })
          .onConflictDoNothing();
        progressed = true;
        active--;
      }
    }
    if (!progressed) break;
  }
  state.graphWaiting = true;
  state.loop.status = 'running';
  await database.orm.transaction(async (tx) => {
    await tx
      .update(workflowRuns)
      .set({ tainted: state.loop.tainted, privateOnly: state.loop.privateOnly })
      .where(eq(workflowRuns.runId, context.run.id));
    await options.persist(tx);
  });
}
