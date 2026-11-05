import { and, eq, sql } from 'drizzle-orm';
import {
  workflowInvocations,
  workflowRuns,
  runAgentVersions,
  runs,
  missionContext,
  missionAllowance,
  remainingSpend,
  enqueueRun,
  workKey,
  valueHash,
  jsonValue,
  type Database,
} from '@sazuz/db';
import {
  workflowInvokeSchema,
  workflowInvocationSchema,
  workflowNodeExecutionSchema,
  WorkflowError,
} from '@sazuz/core/workflows';
import { agentRoleSchema, missionLimitsSchema } from '@sazuz/core/missions';
import type { SettingsDocument } from '@sazuz/config/settings';
import { safeData, snapshotKey, workflowSnapshot } from '@sazuz/workflows';
import { defineTool, type ToolContext } from '@sazuz/tools';
import { runAgent, getAgent } from '@sazuz/orchestrator';
import { durableCheckpointSchema } from './durable-contracts.js';
import { inheritWorkflowAuthority, workflowExecutionRoles } from './workflow-nodes.js';

export function createWorkflowInvocationTool(db: Database, getSettings: () => SettingsDocument) {
  async function receipt(context: ToolContext, raw: unknown) {
    const input = workflowInvokeSchema.parse(raw);
    const [row] = await db.orm
      .select({ receipt: workflowInvocations, workflow: workflowRuns })
      .from(workflowInvocations)
      .innerJoin(workflowRuns, eq(workflowRuns.runId, workflowInvocations.runId))
      .where(
        and(
          eq(workflowInvocations.callKey, context.idempotencyKey),
          eq(workflowInvocations.callerRunId, context.runId),
        ),
      );
    if (!row) return null;
    if (row.receipt.inputHash !== valueHash(input)) throw new WorkflowError('WORKFLOW_CONFLICT');
    return workflowInvocationSchema.parse({
      runId: row.receipt.runId,
      workflowId: row.workflow.workflowId,
      revision: row.workflow.revision,
    });
  }
  return defineTool({
    name: 'workflow.run',
    description:
      'Queue an explicitly reviewed workflow revision in this project as a durable child. Returns its run ID. Requires the caller’s existing pinned agent grants and shares the original mission allowance and deadline.',
    input: workflowInvokeSchema,
    output: workflowInvocationSchema,
    effect: 'write',
    scope: 'internal',
    untrusted: true,
    async run(context, input) {
      const prior = await receipt(context, input);
      if (prior) return prior;
      const caller = await missionContext(db, context.runId);
      if (
        !caller ||
        caller.project.id !== context.projectId ||
        caller.run.claimKey !== context.claimKey ||
        caller.run.status !== 'running'
      )
        throw new WorkflowError('WORKFLOW_INVALID');
      const snapshot = await workflowSnapshot(
        db.orm,
        caller.project.userId,
        input.workflowId,
        input.revision,
      );
      if (snapshot.root.project.id !== caller.project.id)
        throw new WorkflowError('WORKFLOW_NOT_FOUND');
      if (context.modelFree && !snapshot.modelFree) throw new WorkflowError('WORKFLOW_MODEL_FREE');
      const ancestors = await db.pool.query<{ workflowId: string }>(
        `WITH RECURSIVE ancestors AS (
        SELECT id,parent_run_id FROM runs WHERE id=$1 UNION SELECT r.id,r.parent_run_id FROM runs r JOIN ancestors a ON r.id=a.parent_run_id
      ) SELECT w.workflow_id AS "workflowId" FROM workflow_runs w JOIN ancestors a ON a.id=w.run_id`,
        [context.runId],
      );
      const depth = (id: string, revision: number): number =>
        1 +
        Math.max(
          0,
          ...snapshot.snapshot[snapshotKey(id, revision)]!.nodes.map((node) =>
            node.action.kind === 'map' || node.action.kind === 'workflow'
              ? depth(node.action.workflowId, node.action.revision)
              : 0,
          ),
        );
      if (
        ancestors.rows.length + depth(input.workflowId, input.revision) > 4 ||
        Object.keys(snapshot.snapshot).some((key) =>
          ancestors.rows.some((row) => key.startsWith(row.workflowId + ':')),
        )
      )
        throw new WorkflowError('WORKFLOW_INVALID');
      const role = agentRoleSchema.parse(context.agentId);
      const pinned = await runAgent(db, caller.project.userId, context.runId, role),
        current = (await getAgent(db, caller.project.userId, role)).definition;
      const selected = await db.orm
        .select()
        .from(runAgentVersions)
        .where(eq(runAgentVersions.runId, context.runId));
      const roles = workflowExecutionRoles(snapshot.snapshot);
      if (
        [...roles].some(
          (target) =>
            !selected.some((item) => item.role === target) ||
            (target !== role &&
              (!pinned.handoff_to.includes(target) || !current.handoff_to.includes(target))),
        )
      )
        throw new WorkflowError('WORKFLOW_INVALID');
      const checkpoint = durableCheckpointSchema.parse(caller.run.checkpoint);
      const node = caller.run.workflowNode
        ? workflowNodeExecutionSchema.parse(caller.run.workflowNode)
        : null;
      const limits = missionLimitsSchema.parse(caller.run.limits);
      const startedAt = new Date(checkpoint.loop.startedAt);
      if (node)
        limits.maxWallTimeSeconds = Math.min(
          limits.maxWallTimeSeconds,
          Math.max(1, Math.floor((new Date(node.deadline).getTime() - startedAt.getTime()) / 1000)),
        );
      const inputData = safeData(input.input);
      const lease = await db.pool.connect();
      let locked = false;
      try {
        locked =
          (
            await lease.query<{ locked: boolean }>(
              'SELECT pg_try_advisory_lock(72839102) AS locked',
            )
          ).rows[0]?.locked ?? false;
        if (!locked) throw new WorkflowError('WORKFLOW_LIMIT');
        const allowance = await missionAllowance(db, caller.mission.id);
        if (
          allowance.steps < 1 ||
          allowance.usd < 0 ||
          (await remainingSpend(
            db,
            getSettings().budgets.value,
            caller.project.id,
            caller.project.budgetUsd,
          )) < 0 ||
          Date.now() >= startedAt.getTime() + limits.maxWallTimeSeconds * 1000
        )
          throw new WorkflowError('WORKFLOW_LIMIT');
        if (snapshot.modelFree && snapshot.root.project.reviewMode !== 'off')
          throw new WorkflowError('WORKFLOW_MODEL_FREE');
        const count = await db.pool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM workflow_invocations i JOIN runs r ON r.id=i.caller_run_id WHERE r.mission_id=$1',
          [caller.mission.id],
        );
        if ((count.rows[0]?.count ?? 0) >= 16) throw new WorkflowError('WORKFLOW_LIMIT');
        await db.orm.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey},8))`,
          );
          if (
            (
              await tx
                .select()
                .from(workflowInvocations)
                .where(eq(workflowInvocations.callKey, context.idempotencyKey))
            ).length
          )
            return;
          const id = workKey('run');
          await tx.insert(runs).values({
            id,
            missionId: caller.mission.id,
            parentRunId: context.runId,
            agentId: role,
            limits,
            tainted: true,
          });
          await inheritWorkflowAuthority(tx, context.runId, id);
          await tx.insert(workflowRuns).values({
            runId: id,
            workflowId: input.workflowId,
            revision: input.revision,
            snapshot: jsonValue(snapshot.snapshot),
            inputHash: valueHash(inputData),
            input: inputData,
            modelFree: snapshot.modelFree,
            inheritedAuthority: true,
            test: node?.test ?? false,
            privateOnly: checkpoint.loop.privateOnly || caller.project.privacy === 'private',
            tainted: true,
            startedAt,
          });
          await tx.insert(workflowInvocations).values({
            callKey: context.idempotencyKey,
            callerRunId: context.runId,
            runId: id,
            inputHash: valueHash(input),
          });
          await enqueueRun(tx, id);
        });
      } finally {
        let reusable = false;
        try {
          if (locked) await lease.query('SELECT pg_advisory_unlock(72839102)');
          reusable = true;
        } finally {
          lease.release(!reusable);
        }
      }
      const saved = await receipt(context, input);
      if (!saved) throw new WorkflowError('WORKFLOW_INVALID');
      return saved;
    },
    async verify(context, input) {
      const saved = await receipt(context, input);
      return saved ? { status: 'done' as const, result: saved } : { status: 'not_done' as const };
    },
  });
}
