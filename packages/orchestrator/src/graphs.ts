import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  graphPlanSchema,
  graphTaskSchema,
  taskAssignmentSchema,
  taskResultSchema,
  replanSchema,
  type GraphPlan,
  type Replan,
} from '@sazuz/core/graphs';
import { agentRoleSchema } from '@sazuz/core/agents';
import { missionLimitsSchema } from '@sazuz/core/missions';
import type { SettingsDocument } from '@sazuz/config/settings';
import {
  agentMessages,
  missionGraphs,
  graphRevisions,
  missionTasks,
  taskAttempts,
  runAgentVersions,
  runs,
  toolCalls,
  jsonValue,
  workKey,
  missionContext,
  enqueueRun,
  missionAllowance,
  graphView,
  type Database,
  type Transaction,
} from '@sazuz/db';
import { pinAgent, runAgent, getAgent } from './agents.js';
import { OrchestrationError } from './errors.js';

type MissionContext = NonNullable<Awaited<ReturnType<typeof missionContext>>>;
async function rootLock(tx: Transaction, context: MissionContext, claimKey: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${context.mission.id},6))`);
  const [root] = await tx
    .select()
    .from(runs)
    .where(
      and(eq(runs.id, context.run.id), eq(runs.claimKey, claimKey), eq(runs.status, 'running')),
    );
  if (!root || root.parentRunId || root.agentId !== 'cos' || context.mission.agent !== 'cos')
    throw new OrchestrationError('GRAPH_INVALID');
}
export async function initializeGraph(
  db: Database,
  context: MissionContext,
  claimKey: string,
  input: unknown,
  settings: SettingsDocument,
) {
  const plan = graphPlanSchema.parse(jsonValue(input));
  if (!plan.tasks.length) throw new OrchestrationError('GRAPH_INVALID');
  const cos = await runAgent(db, context.project.userId, context.run.id, 'cos');
  // Freeze delegation authority for this mission, including potential replacement specialists.
  for (const role of cos.handoff_to) {
    const current = await getAgent(db, context.project.userId, role);
    if (current.definition.enabled)
      await pinAgent(
        db,
        context.project.userId,
        context.run.id,
        role,
        settings.connectors.value.accounts,
      );
  }
  for (const task of plan.tasks) {
    if (!cos.handoff_to.includes(task.agent)) throw new OrchestrationError('GRAPH_INVALID');
    await runAgent(db, context.project.userId, context.run.id, task.agent);
  }
  await db.orm.transaction(async (tx) => {
    await rootLock(tx, context, claimKey);
    const inserted = await tx
      .insert(missionGraphs)
      .values({
        missionId: context.mission.id,
        rootRunId: context.run.id,
        definition: jsonValue(plan),
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length) return;
    await tx.insert(graphRevisions).values({
      id: workKey('grv'),
      missionId: context.mission.id,
      revision: 1,
      definition: jsonValue(plan),
      reason: 'Initial Chief of Staff plan.',
    });
    for (const task of plan.tasks)
      await tx.insert(missionTasks).values({
        id: workKey('tsk'),
        missionId: context.mission.id,
        taskKey: task.id,
        definition: jsonValue(task),
      });
    await tx.execute(sql`SELECT pg_notify('execution_changed',${context.run.id})`);
  });
}
const resultCheckpoint = z.object({
  loop: z.object({
    messages: z.array(z.object({ role: z.string(), content: z.string() })),
    tainted: z.boolean(),
    privateOnly: z.boolean().default(false),
  }),
});
export function taskResult(run: typeof runs.$inferSelect, taskKey: string) {
  const checkpoint = resultCheckpoint.parse(run.checkpoint);
  return taskResultSchema.parse({
    taskId: taskKey,
    agent: run.agentId,
    text:
      [...checkpoint.loop.messages]
        .reverse()
        .find((message) => message.role === 'assistant')
        ?.content.slice(0, 100000) ?? '',
    tainted: checkpoint.loop.tainted,
    privateOnly: checkpoint.loop.privateOnly,
  });
}
export async function synchronizeGraph(db: Database, context: MissionContext, claimKey: string) {
  await db.orm.transaction(async (tx) => {
    await rootLock(tx, context, claimKey);
    const tasks = await tx
      .select({ task: missionTasks, run: runs })
      .from(missionTasks)
      .innerJoin(runs, eq(runs.id, missionTasks.runId))
      .where(eq(missionTasks.missionId, context.mission.id));
    for (const { task, run } of tasks) {
      if (task.status === 'completed' || task.status === 'rejected') continue;
      const result = run.status === 'completed' ? taskResult(run, task.taskKey) : null;
      const status =
        result && !result.text.trim()
          ? 'failed'
          : run.status === 'failed' && run.reason?.startsWith('Auditor rejected output:')
            ? 'rejected'
            : run.status;
      const feedback = ['failed', 'rejected'].includes(status)
        ? (run.reason ?? 'The task produced no usable output.')
        : task.feedback;
      await tx
        .update(missionTasks)
        .set({ status, result: result ? jsonValue(result) : null, feedback, updatedAt: new Date() })
        .where(eq(missionTasks.id, task.id));
      if (['completed', 'failed', 'rejected', 'budget_exceeded', 'cancelled'].includes(status))
        await tx
          .insert(agentMessages)
          .values({
            id: workKey('agm'),
            missionId: context.mission.id,
            taskId: task.taskKey,
            eventKey: `task:${task.id}:${task.attempt}:${status}`,
            from: run.agentId,
            to: 'cos',
            type: status === 'completed' ? 'result' : 'escalate',
            content: result?.text || feedback || run.reason || status,
            payload: jsonValue({ runId: run.id, attempt: task.attempt, status }),
          })
          .onConflictDoNothing();
    }
  });
  return (await graphView(db, context.project.userId, context.mission.id))!;
}
export async function dispatchReadyTasks(
  db: Database,
  context: MissionContext,
  claimKey: string,
  startedAt: string,
  inherited: { tainted: boolean; privateOnly: boolean },
) {
  const view = await graphView(db, context.project.userId, context.mission.id);
  if (!view) throw new OrchestrationError('GRAPH_NOT_FOUND');
  const allowance = await missionAllowance(db, context.mission.id);
  if (allowance.steps <= 0 || allowance.usd < 0) throw new OrchestrationError('GRAPH_BUDGET');
  const ready = view.tasks.filter(
    (task) =>
      task.status === 'pending' &&
      task.definition.depends_on.every(
        (id) => view.tasks.find((dependency) => dependency.key === id)?.status === 'completed',
      ),
  );
  const rootLimits = missionLimitsSchema.parse(allowance.root.limits);
  for (const task of ready) {
    const definition = await runAgent(
      db,
      context.project.userId,
      context.run.id,
      task.definition.agent,
    );
    if (!(await getAgent(db, context.project.userId, task.definition.agent)).definition.enabled)
      throw new OrchestrationError('AGENT_DISABLED');
    const steps = Math.min(
      task.definition.budget.steps - task.steps,
      definition.budget.max_steps,
      allowance.steps,
    );
    const usd = Math.min(
      task.definition.budget.usd - task.costUsd,
      definition.budget.max_cost_usd,
      allowance.usd,
    );
    if (steps < 1 || usd < 0) throw new OrchestrationError('GRAPH_BUDGET');
    const dependencies = task.definition.depends_on.map(
      (id) => view.tasks.find((dependency) => dependency.key === id)!.result!,
    );
    const assignment = taskAssignmentSchema.parse({
      taskId: task.id,
      taskKey: task.key,
      attempt: task.attempt + 1,
      task: task.definition,
      dependencies,
      feedback: task.feedback,
      userCheckpoints: view.plan.user_checkpoints,
      startedAt,
      tainted:
        inherited.tainted || dependencies.length > 0 || dependencies.some((item) => item.tainted),
      privateOnly: inherited.privateOnly || dependencies.some((item) => item.privateOnly),
    });
    await db.orm.transaction(async (tx) => {
      await rootLock(tx, context, claimKey);
      const [current] = await tx
        .select()
        .from(missionTasks)
        .where(eq(missionTasks.id, task.id))
        .for('update');
      if (!current || current.status !== 'pending') return;
      const runId = workKey('run');
      await tx.insert(runs).values({
        id: runId,
        missionId: context.mission.id,
        parentRunId: context.run.id,
        agentId: task.definition.agent,
        assignment: jsonValue(assignment),
        tainted: assignment.tainted,
        limits: {
          maxSteps: steps,
          maxCostUsd: usd,
          maxWallTimeSeconds: Math.min(
            rootLimits.maxWallTimeSeconds,
            definition.budget.max_wall_time_seconds,
          ),
        },
      });
      const [pinned] = await tx
        .select()
        .from(runAgentVersions)
        .where(
          and(
            eq(runAgentVersions.runId, context.run.id),
            eq(runAgentVersions.role, task.definition.agent),
          ),
        );
      if (!pinned) throw new OrchestrationError('AGENT_NOT_FOUND');
      await tx.insert(runAgentVersions).values({
        runId,
        role: pinned.role,
        revisionId: pinned.revisionId,
        connectorBindings: pinned.connectorBindings,
      });
      await tx
        .insert(taskAttempts)
        .values({ id: workKey('tat'), taskId: task.id, runId, attempt: assignment.attempt });
      await tx
        .update(missionTasks)
        .set({ runId, attempt: assignment.attempt, status: 'queued', updatedAt: new Date() })
        .where(eq(missionTasks.id, task.id));
      await tx.insert(agentMessages).values({
        id: workKey('agm'),
        missionId: context.mission.id,
        taskId: task.key,
        eventKey: `assign:${task.id}:${assignment.attempt}`,
        from: 'cos',
        to: task.definition.agent,
        type: 'assign',
        content: task.definition.goal,
        payload: jsonValue({
          goal: task.definition.goal,
          inputs: task.definition.inputs,
          acceptance: task.definition.acceptance,
          budget: task.definition.budget,
          deadline: new Date(
            new Date(startedAt).getTime() + rootLimits.maxWallTimeSeconds * 1000,
          ).toISOString(),
          runId,
          attempt: assignment.attempt,
        }),
      });
      await enqueueRun(tx, runId);
    });
  }
  return ready.length;
}
export async function reviseGraph(
  db: Database,
  context: MissionContext,
  claimKey: string,
  input: Replan,
  expectedRevision: number,
) {
  const revision = replanSchema.parse(jsonValue(input));
  if (revision.action === 'ask_user') {
    await db.orm.transaction(async (tx) => {
      await rootLock(tx, context, claimKey);
      await tx
        .insert(agentMessages)
        .values({
          id: workKey('agm'),
          missionId: context.mission.id,
          eventKey: `question:${expectedRevision}`,
          from: 'cos',
          to: 'user',
          type: 'question',
          content: revision.question,
        })
        .onConflictDoNothing();
    });
    return false;
  }
  const cos = await runAgent(db, context.project.userId, context.run.id, 'cos');
  if (!cos.handoff_to.includes(revision.agent)) throw new OrchestrationError('GRAPH_INVALID');
  await runAgent(db, context.project.userId, context.run.id, revision.agent);
  await db.orm.transaction(async (tx) => {
    await rootLock(tx, context, claimKey);
    const [graph] = await tx
      .select()
      .from(missionGraphs)
      .where(eq(missionGraphs.missionId, context.mission.id));
    const [task] = await tx
      .select()
      .from(missionTasks)
      .where(
        and(
          eq(missionTasks.missionId, context.mission.id),
          eq(missionTasks.taskKey, revision.taskId),
        ),
      );
    if (
      !graph ||
      graph.revision !== expectedRevision ||
      !task ||
      !['failed', 'rejected'].includes(task.status)
    )
      throw new OrchestrationError('GRAPH_INVALID');
    if (graph.revision >= 9 || task.attempt >= 3)
      throw new OrchestrationError('GRAPH_REPLAN_LIMIT');
    const uncertain = await tx
      .select({ id: toolCalls.id })
      .from(toolCalls)
      .innerJoin(taskAttempts, eq(taskAttempts.runId, toolCalls.runId))
      .where(
        and(
          eq(taskAttempts.taskId, task.id),
          sql`${toolCalls.effect}<>'read' AND ${toolCalls.status} NOT IN ('done','retry_ready')`,
        ),
      );
    if (uncertain.length) throw new OrchestrationError('GRAPH_UNCERTAIN');
    const definition = graphTaskSchema.parse(task.definition);
    const next = { ...definition, agent: revision.agent, goal: revision.goal };
    const plan: GraphPlan = graphPlanSchema.parse(graph.definition);
    plan.tasks = plan.tasks.map((item) => (item.id === revision.taskId ? next : item));
    await tx
      .update(missionGraphs)
      .set({ definition: jsonValue(plan), revision: graph.revision + 1 })
      .where(eq(missionGraphs.missionId, context.mission.id));
    await tx.insert(graphRevisions).values({
      id: workKey('grv'),
      missionId: context.mission.id,
      revision: graph.revision + 1,
      definition: jsonValue(plan),
      reason: revision.reason,
    });
    await tx
      .update(missionTasks)
      .set({
        definition: jsonValue(next),
        status: 'pending',
        result: null,
        runId: null,
        feedback: (task.feedback ?? '') + '\n' + revision.reason,
        updatedAt: new Date(),
      })
      .where(eq(missionTasks.id, task.id));
    await tx.insert(agentMessages).values({
      id: workKey('agm'),
      missionId: context.mission.id,
      taskId: task.taskKey,
      eventKey: `replan:${graph.revision + 1}`,
      from: 'cos',
      to: revision.agent,
      type: revision.agent === definition.agent ? 'progress' : 'handoff',
      content: revision.reason,
      payload: jsonValue({
        revision: graph.revision + 1,
        preservedAcceptance: definition.acceptance,
        budget: definition.budget,
      }),
    });
    await tx.execute(sql`SELECT pg_notify('execution_changed',${context.run.id})`);
  });
  return true;
}
export async function priorTaskEffect(
  db: Database,
  runId: string,
  toolName: string,
  argsHash: string,
) {
  const [current] = await db.orm.select().from(taskAttempts).where(eq(taskAttempts.runId, runId));
  if (!current) return null;
  const [prior] = await db.orm
    .select({ call: toolCalls })
    .from(taskAttempts)
    .innerJoin(toolCalls, eq(toolCalls.runId, taskAttempts.runId))
    .where(
      and(
        eq(taskAttempts.taskId, current.taskId),
        sql`${taskAttempts.attempt}<${current.attempt}`,
        eq(toolCalls.toolName, toolName),
        eq(toolCalls.argsHash, argsHash),
        eq(toolCalls.status, 'done'),
      ),
    )
    .orderBy(asc(taskAttempts.attempt))
    .limit(1);
  return prior?.call ?? null;
}
export async function activeAssignment(db: Database, runId: string) {
  const context = await missionContext(db, runId);
  if (!context || !['running', 'waiting_approval'].includes(context.run.status))
    throw new OrchestrationError('GRAPH_NOT_FOUND');
  const role = agentRoleSchema.parse(context.run.agentId);
  return {
    context,
    role,
    assignment: context.run.assignment ? taskAssignmentSchema.parse(context.run.assignment) : null,
  };
}
