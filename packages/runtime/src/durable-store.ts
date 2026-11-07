import { and, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SettingsDocument } from '@sazuz/config/settings';
import {
  approvalDecisionSchema,
  missionLimitsSchema,
  type ApprovalDecision,
} from '@sazuz/core/missions';
import { evaluatePolicy, type PolicyDecision } from '@sazuz/policy';
import {
  renderToolOutput,
  type ToolContext,
  type ToolDescriptor,
  type ToolExecution,
  ToolRegistry,
} from '@sazuz/tools';
import type { LlmToolCall } from '@sazuz/llm/contracts';
import {
  approvals,
  artifacts,
  auditLog,
  enqueueRun,
  getControl,
  jsonValue,
  missionContext,
  runHasStoppedAncestor,
  MissionError,
  publicApproval,
  remainingSpend,
  missionAllowance,
  missionGraphs,
  projectReview,
  runs,
  toolCalls,
  learnedReplays,
  skills,
  valueHash,
  workKey,
  type Database,
  type Transaction,
} from '@sazuz/db';
import { RunSuspension, type RunCheckpoint } from './contracts.js';
import { durableCheckpointSchema } from './durable-contracts.js';
import { secretRedactor } from '@sazuz/vault';
import { isSkillLoad } from '@sazuz/core/skills';
import { inheritedRecipePolicy } from './recipe-policy.js';
import {
  agentActionPermission,
  agentAuditIdentity,
  hasPinnedAgent,
  priorTaskEffect,
  acceptedActionReview,
  runAgent,
  getAgent,
  matchesTool,
} from '@sazuz/orchestrator';
import { agentRoleSchema } from '@sazuz/core/agents';
import type { ReviewRecord } from '@sazuz/core/reviews';
import { mcpTools, selectedMcp, mcpActionAllowed } from '@sazuz/mcp';
import { bridgeTools, selectedBridge, bridgeActionAllowed } from '@sazuz/bridge';
import { isWorkflowControl, createWorkflowControlTools } from '@sazuz/workflows';
import { workflowNodeExecutionSchema } from '@sazuz/core/workflows';
import { createWorkflowInvocationTool } from './workflow-invocation.js';
import { createProjectActivityTool } from './project-activity.js';
import { isS2aControl, s2aTools, workflowAllows } from '@sazuz/workflows/s2a';
import { createMcpTools, mcpToolName } from '@sazuz/mcp/connections';

const executionSchema = z.strictObject({
  output: z.json(),
  untrusted: z.boolean(),
  privateOnly: z.boolean().default(false),
  pause: z.string().min(1).max(500).optional(),
});
export interface ActionStoreOptions {
  database: Database;
  runId: string;
  userId: string;
  projectId: string;
  projectCap: number;
  getSettings: () => SettingsDocument;
  tools: ToolRegistry;
  review?(
    call: LlmToolCall,
    tool: ToolDescriptor,
    state: RunCheckpoint,
  ): Promise<ReviewRecord | null>;
}
export class ActionStore {
  constructor(readonly options: ActionStoreOptions) {}
  key(state: RunCheckpoint) {
    return `${this.options.runId}:${state.step}:${state.nextCall}`;
  }
  async policy(
    call: LlmToolCall,
    tool: ToolDescriptor,
    state: RunCheckpoint,
  ): Promise<PolicyDecision> {
    const { database, getSettings, projectId, projectCap, runId } = this.options;
    const settings = getSettings();
    const counts = await database.pool.query<{ hour: number; run: number }>(
      "SELECT count(*) FILTER (WHERE created_at>now()-interval '1 hour')::int AS hour,count(*) FILTER (WHERE run_id=$1)::int AS run FROM tool_calls WHERE tool_name=$2",
      [runId, call.name],
    );
    const usage = Object.fromEntries(
      settings.security.value.rules.map((rule) => [rule.id, counts.rows[0] ?? { hour: 0, run: 0 }]),
    );
    const context = (await missionContext(database, runId))!;
    const [learned] = await database.orm
      .select({ enabled: skills.enabled })
      .from(learnedReplays)
      .innerJoin(skills, eq(skills.id, learnedReplays.skillId))
      .where(eq(learnedReplays.runId, runId));
    if (learned && !learned.enabled)
      return {
        action: 'deny',
        effect: tool.effect,
        ruleId: 'learned-skill-disabled',
        matchedRuleIds: ['learned-skill-disabled'],
        reason: 'This learned skill is disabled.',
      };
    if (context.run.parentRunId && (await runHasStoppedAncestor(database, runId)))
      throw new RunSuspension('paused', 'Stopped with the parent mission.');
    const agent = agentRoleSchema.parse(context.run.agentId);
    const workflowNode = context.run.workflowNode
      ? workflowNodeExecutionSchema.parse(context.run.workflowNode)
      : null;
    const s2a = durableCheckpointSchema.safeParse(context.run.checkpoint).data?.workflow;
    const control =
      isWorkflowControl(context.run.workflowNode, call.name) || isS2aControl(s2a, call.name);
    if (
      (s2a && !workflowAllows(s2a, call.name)) ||
      (!s2a && call.name.startsWith('s2a.')) ||
      (call.name.startsWith('mcp_connection.') &&
        !settings.advanced.value.mcp.some(
          (connection) =>
            connection.enabled &&
            connection.agents.includes(agent) &&
            connection.tools.some(
              (entry) => entry.enabled && mcpToolName(connection.id, entry.name) === call.name,
            ),
        ))
    )
      return {
        action: 'deny',
        effect: tool.effect,
        ruleId: 'integration-scope',
        reason: 'This tool is unavailable to the active workflow node or agent.',
        matchedRuleIds: ['integration-scope'],
      };
    if (control) {
      const identities = [
        await runAgent(database, this.options.userId, runId, agent),
        (await getAgent(database, this.options.userId, agent)).definition,
      ];
      if (
        identities.some(
          (identity) => !identity.enabled || matchesTool(identity.permissions.deny, call.name),
        )
      )
        return {
          action: 'deny',
          effect: tool.effect,
          ruleId: 'agent-scope',
          reason: 'This agent or control node has been disabled.',
          matchedRuleIds: ['agent-scope'],
        };
    }
    if (
      (!control && ['workflow.checkpoint', 'workflow.notify'].includes(call.name)) ||
      workflowNode?.action.kind === 'classify'
    )
      return {
        action: 'deny',
        effect: tool.effect,
        ruleId: 'workflow-node-scope',
        reason: 'This tool is unavailable to this workflow node.',
        matchedRuleIds: ['workflow-node-scope'],
      };
    if (
      call.name.startsWith('local.') &&
      !(await bridgeActionAllowed(database, runId, agent, call.name, call.args))
    )
      return {
        action: 'deny',
        effect: tool.effect,
        ruleId: 'bridge-scope',
        reason: 'The Bridge device, pin or agent grant is no longer available.',
        matchedRuleIds: ['bridge-scope'],
      };
    if (
      call.name.startsWith('mcp.') &&
      !(await mcpActionAllowed(database, runId, agent, call.name))
    )
      return {
        action: 'deny',
        effect: tool.effect,
        ruleId: 'mcp-scope',
        reason: 'The MCP installation, pin or agent grant is no longer available.',
        matchedRuleIds: ['mcp-scope'],
      };
    if (
      !control &&
      (await hasPinnedAgent(database, runId, agent)) &&
      !(await agentActionPermission(
        database,
        this.options.userId,
        runId,
        agent,
        call.name,
        call.args,
        tool.effect,
        settings.connectors.value.accounts,
      ))
    )
      return {
        action: 'deny',
        effect: tool.effect,
        ruleId: 'agent-scope',
        reason: 'This agent lacks the required tool or connector account scope.',
        matchedRuleIds: ['agent-scope'],
      };
    const allowance = await missionAllowance(database, context.mission.id);
    const decision = evaluatePolicy({
      ...(await inheritedRecipePolicy(database, runId, context.mission.recipePolicy)),
      tool: call.name,
      args: call.args,
      effect: tool.effect,
      effectKnown: tool.effectKnown,
      scope: tool.scope,
      ...(tool.connector ? { connector: tool.connector } : {}),
      moneyMovement: tool.moneyMovement ?? false,
      agentId: context.run.agentId,
      projectId,
      tainted: state.tainted,
      preset: settings.security.value.preset,
      rules: settings.security.value.rules,
      usage,
      paused: (await getControl(database)).paused,
      budget: {
        remainingSteps: Math.min(
          missionLimitsSchema.parse(context.run.limits).maxSteps -
            state.step -
            context.run.reviewSteps +
            1,
          allowance.steps + 1,
        ),
        remainingUsd: Math.min(
          allowance.usd,
          missionLimitsSchema.parse(context.run.limits).maxCostUsd - context.run.costUsd,
          await remainingSpend(database, settings.budgets.value, projectId, projectCap),
        ),
        remainingMs: Number.MAX_SAFE_INTEGER,
      },
    });
    if (decision.action === 'allow' && tool.scope === 'external' && tool.effect !== 'read') {
      const [graph] = await database.orm
        .select()
        .from(missionGraphs)
        .where(eq(missionGraphs.missionId, context.mission.id));
      const checkpoints = z
        .object({ user_checkpoints: z.array(z.string()) })
        .safeParse(graph?.definition);
      if (checkpoints.success && checkpoints.data.user_checkpoints.length)
        return {
          ...decision,
          action: 'ask',
          ruleId: 'mission-checkpoint',
          matchedRuleIds: [...decision.matchedRuleIds, 'mission-checkpoint'],
          reason: `Mission checkpoint: ${checkpoints.data.user_checkpoints.join('; ')}`,
        };
    }
    if (call.name === 's2a.approval' && decision.action !== 'deny')
      return {
        ...decision,
        action: 'ask',
        ruleId: 's2a-checkpoint',
        reason: 'This S2A workflow requires your explicit approval.',
      };
    return decision;
  }
  async ensureApproval(
    call: LlmToolCall,
    tool: ToolDescriptor,
    state: RunCheckpoint,
    decision: PolicyDecision,
    kind: 'policy' | 'uncertain' = 'policy',
  ) {
    const { database, runId } = this.options;
    const context = await missionContext(database, runId);
    if (!context) throw new MissionError('MISSION_NOT_FOUND');
    const callKey = this.key(state),
      argsHash = valueHash(call.args);
    await database.orm
      .insert(approvals)
      .values({
        id: workKey('apr'),
        runId,
        callKey,
        agentId: context.run.agentId,
        toolName: call.name,
        args: jsonValue(call.args),
        argsHash,
        effect: tool.effect,
        reason: decision.reason,
        risk:
          tool.effect === 'read'
            ? 'low'
            : ['send', 'delete', 'spend', 'publish'].includes(tool.effect)
              ? 'high'
              : 'medium',
        ruleId: decision.ruleId,
        tainted: state.tainted,
        kind,
        expiresAt: new Date(Date.now() + 86400000),
      })
      .onConflictDoNothing();
    let [row] = await database.orm
      .select()
      .from(approvals)
      .where(
        and(eq(approvals.runId, runId), eq(approvals.callKey, callKey), eq(approvals.kind, kind)),
      );
    if (!row || row.argsHash !== argsHash) throw new MissionError('APPROVAL_INVALID');
    if (kind === 'uncertain' && row.status !== 'pending') {
      [row] = await database.orm
        .update(approvals)
        .set({
          status: 'pending',
          decision: null,
          decidedBy: null,
          note: null,
          reason: decision.reason,
          expiresAt: new Date(Date.now() + 86400000),
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(approvals.id, row.id))
        .returning();
    }
    return row!;
  }
  async preReview(
    call: LlmToolCall,
    tool: ToolDescriptor,
    state: RunCheckpoint,
  ): Promise<PolicyDecision | null> {
    const { database, runId, getSettings } = this.options;
    if (tool.scope !== 'external' || tool.effect === 'read') return null;
    if (
      !(await acceptedActionReview(database, runId, this.key(state), call, tool, getSettings()))
    ) {
      if (!this.options.review)
        throw new RunSuspension(
          'paused',
          'An independent Auditor review is required before this action.',
        );
      const review = await this.options.review(call, tool, state);
      if (review?.status !== 'accepted') {
        const reason =
          review?.verdict?.feedback ?? 'The independent Auditor did not accept this action.';
        await database.orm
          .update(approvals)
          .set({
            status: 'denied',
            note: reason,
            version: sql`${approvals.version}+1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(approvals.runId, runId),
              eq(approvals.callKey, this.key(state)),
              eq(approvals.status, 'reviewing'),
            ),
          );
        return {
          action: 'deny',
          effect: tool.effect,
          ruleId: 'auditor',
          reason,
          matchedRuleIds: ['auditor'],
        };
      }
      if (
        !(await acceptedActionReview(database, runId, this.key(state), call, tool, getSettings()))
      )
        throw new RunSuspension(
          'paused',
          'The action or review constraints changed. Resume for a fresh review.',
        );
    }
    // Exact edited consent survives review, but cannot execute until this gate passes.
    await database.orm
      .update(approvals)
      .set({ status: 'approved', version: sql`${approvals.version}+1`, updatedAt: new Date() })
      .where(
        and(
          eq(approvals.runId, runId),
          eq(approvals.callKey, this.key(state)),
          eq(approvals.argsHash, valueHash(call.args)),
          eq(approvals.status, 'reviewing'),
          gt(approvals.expiresAt, new Date()),
        ),
      );
    return null;
  }
  async authorize(
    call: LlmToolCall,
    tool: ToolDescriptor,
    state: RunCheckpoint,
  ): Promise<PolicyDecision> {
    const { database, runId, userId } = this.options;
    const [intent] = await database.orm
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.idempotencyKey, this.key(state)));
    // Recovery may inspect an already recorded effect; execute() still rechecks before a fresh attempt.
    if (
      intent ||
      (tool.effect !== 'read' &&
        (await priorTaskEffect(database, runId, call.name, valueHash(call.args))))
    )
      return {
        action: 'allow',
        effect: tool.effect,
        ruleId: 'intent-reconciliation',
        reason: 'Reconcile the previously recorded action.',
        matchedRuleIds: [],
      };
    let decision = await this.policy(call, tool, state);
    if (decision.action !== 'deny') {
      const rejected = await this.preReview(call, tool, state);
      decision = rejected ?? (await this.policy(call, tool, state));
    }
    if (decision.action === 'ask') {
      const approval = await this.ensureApproval(call, tool, state, decision);
      if (approval.status === 'approved' && approval.expiresAt.getTime() > Date.now())
        decision = {
          ...decision,
          action: 'allow',
          reason: 'Explicit approval for these exact arguments.',
          ruleId: `approval:${approval.id}`,
        };
      else if (
        approval.status === 'denied' ||
        approval.status === 'expired' ||
        approval.expiresAt.getTime() <= Date.now()
      )
        decision = {
          ...decision,
          action: 'deny',
          reason: approval.note
            ? `The owner declined: ${approval.note}`
            : 'Approval denied or expired.',
          ruleId: `approval:${approval.id}`,
        };
    }
    const context = await missionContext(database, runId);
    const role = agentRoleSchema.parse(context!.run.agentId);
    const actor = (await hasPinnedAgent(database, runId, role))
      ? await agentAuditIdentity(database, userId, runId, role)
      : userId;
    await database.orm.insert(auditLog).values({
      id: workKey('aud'),
      actorId: actor,
      action: `policy.${decision.action}`,
      target: `${runId}:${call.name}:${decision.ruleId}`,
    });
    return decision;
  }
  async execute(
    call: LlmToolCall,
    tool: ToolDescriptor,
    context: ToolContext,
    state: RunCheckpoint,
  ): Promise<ToolExecution> {
    const { database, tools, runId } = this.options;
    const key = context.idempotencyKey,
      argsHash = valueHash(call.args);
    let [intent] = await database.orm
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.idempotencyKey, key));
    if (intent && intent.argsHash !== argsHash) throw new MissionError('APPROVAL_INVALID');
    if (intent?.status === 'done') return executionSchema.parse(intent.result);
    if (!intent && tool.effect !== 'read') {
      const prior = await priorTaskEffect(database, runId, call.name, argsHash);
      if (prior) {
        const result = executionSchema.parse(prior.result);
        await database.orm
          .insert(toolCalls)
          .values({
            id: workKey('call'),
            runId,
            idempotencyKey: key,
            toolName: call.name,
            args: jsonValue(call.args),
            argsHash,
            effect: tool.effect,
            status: 'done',
            result: jsonValue(result),
          })
          .onConflictDoNothing();
        await database.orm.insert(auditLog).values({
          id: workKey('aud'),
          actorId: this.options.userId,
          action: 'task.effect_replayed',
          target: prior.id,
        });
        return result;
      }
    }
    if (intent && intent.status !== 'retry_ready') {
      await database.orm
        .update(toolCalls)
        .set({ status: 'uncertain', updatedAt: new Date() })
        .where(eq(toolCalls.id, intent.id));
      let verified: Awaited<ReturnType<ToolRegistry['verify']>> = { status: 'unknown' };
      if (tool.effect === 'read') verified = { status: 'not_done' };
      else
        try {
          verified = await tools.verify(call.name, context, call.args);
        } catch {
          database.logger.warn(
            { code: 'TOOL_VERIFICATION_UNAVAILABLE', runId },
            'An interrupted action still needs verification.',
          );
        }
      if (verified.status === 'done') {
        await database.orm
          .update(toolCalls)
          .set({ status: 'done', result: jsonValue(verified.result), updatedAt: new Date() })
          .where(eq(toolCalls.id, intent.id));
        await database.orm
          .update(approvals)
          .set({ status: 'resolved', updatedAt: new Date() })
          .where(
            and(
              eq(approvals.runId, runId),
              eq(approvals.callKey, key),
              sql`${approvals.status} IN ('pending','approved')`,
            ),
          );
        return verified.result;
      }
      if (verified.status === 'unknown') {
        const reason =
          'The worker stopped before this action was confirmed. Verify what happened before continuing.';
        await this.ensureApproval(
          call,
          tool,
          state,
          {
            action: 'ask',
            reason,
            ruleId: 'uncertain-side-effect',
            effect: tool.effect,
            matchedRuleIds: [],
          },
          'uncertain',
        );
        throw new RunSuspension('waiting_approval', reason);
      }
      await database.orm
        .update(toolCalls)
        .set({ status: 'retry_ready', updatedAt: new Date() })
        .where(eq(toolCalls.id, intent.id));
      intent = { ...intent, status: 'retry_ready' };
    }
    if (context.signal.aborted || (await getControl(database)).paused)
      throw new RunSuspension('paused', 'Paused before the next action.');
    let current = await this.policy(call, tool, state);
    if (current.action !== 'deny')
      current = (await this.preReview(call, tool, state)) ?? (await this.policy(call, tool, state));
    if (current.action === 'deny') {
      const result = { output: { denied: true, reason: current.reason }, untrusted: false };
      if (intent)
        await database.orm
          .update(toolCalls)
          .set({ status: 'done', result: jsonValue(result), updatedAt: new Date() })
          .where(eq(toolCalls.id, intent.id));
      return result;
    }
    if (current.action === 'ask') {
      const approval = await this.ensureApproval(call, tool, state, current);
      if (
        approval.status === 'denied' ||
        approval.status === 'expired' ||
        approval.expiresAt.getTime() <= Date.now()
      ) {
        const result = {
          output: { denied: true, reason: approval.note ?? 'Approval denied or expired.' },
          untrusted: false,
        };
        if (intent)
          await database.orm
            .update(toolCalls)
            .set({ status: 'done', result: jsonValue(result), updatedAt: new Date() })
            .where(eq(toolCalls.id, intent.id));
        return result;
      }
      if (approval.status !== 'approved')
        throw new RunSuspension('waiting_approval', current.reason);
    }
    if (!intent) {
      [intent] = await database.orm
        .insert(toolCalls)
        .values({
          id: workKey('call'),
          runId,
          idempotencyKey: key,
          toolName: call.name,
          args: jsonValue(call.args),
          argsHash,
          effect: tool.effect,
          status: 'intent',
        })
        .returning();
    } else
      await database.orm
        .update(toolCalls)
        .set({ status: 'intent', attempt: intent.attempt + 1, updatedAt: new Date() })
        .where(eq(toolCalls.id, intent.id));
    let result: ToolExecution;
    try {
      result = await tools.execute(call.name, context, call.args);
    } catch (error) {
      if (tool.effect === 'read') {
        await database.orm
          .update(toolCalls)
          .set({ status: 'retry_ready', updatedAt: new Date() })
          .where(eq(toolCalls.id, intent!.id));
        throw error;
      }
      await database.orm
        .update(toolCalls)
        .set({ status: 'uncertain', updatedAt: new Date() })
        .where(eq(toolCalls.id, intent!.id));
      const reason =
        'The action returned without confirmation. Verify its outcome before retrying.';
      await this.ensureApproval(
        call,
        tool,
        state,
        {
          action: 'ask',
          reason,
          effect: tool.effect,
          ruleId: 'uncertain-side-effect',
          matchedRuleIds: [],
        },
        'uncertain',
      );
      throw new RunSuspension('waiting_approval', reason);
    }
    await database.orm.transaction(async (tx) => {
      await tx
        .update(toolCalls)
        .set({ status: 'done', result: jsonValue(result), updatedAt: new Date() })
        .where(eq(toolCalls.id, intent!.id));
      await tx
        .update(approvals)
        .set({ status: 'resolved', updatedAt: new Date() })
        .where(
          and(
            eq(approvals.runId, runId),
            eq(approvals.callKey, key),
            eq(approvals.status, 'approved'),
          ),
        );
    });
    return result;
  }
  async observation(call: LlmToolCall, result: ToolExecution, state: RunCheckpoint) {
    const text = renderToolOutput(result);
    if (Buffer.byteLength(text) <= 8192 || isSkillLoad(call.name, result.output)) return text;
    const { database, runId } = this.options;
    const eventKey = `${state.step}:${state.nextCall}`;
    await database.orm
      .insert(artifacts)
      .values({ id: workKey('art'), runId, eventKey, content: text, untrusted: result.untrusted })
      .onConflictDoNothing();
    const [artifact] = await database.orm
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, runId), eq(artifacts.eventKey, eventKey)));
    return renderToolOutput({
      output: {
        artifactId: artifact!.id,
        characters: text.length,
        summary: text.slice(0, 2000),
        instruction: 'Use artifact.read with this handle and an offset to inspect more.',
      },
      untrusted: result.untrusted,
    });
  }
}

export async function decideApproval(
  database: Database,
  userId: string,
  approvalId: string,
  input: unknown,
  tools: ToolRegistry,
  getSettings: () => SettingsDocument,
) {
  const parsed = approvalDecisionSchema.safeParse(input);
  if (!parsed.success) throw new MissionError('APPROVAL_INVALID');
  const command: ApprovalDecision = parsed.data;
  command.note = secretRedactor.redactText(command.note);
  const [initial] = await database.orm.select().from(approvals).where(eq(approvals.id, approvalId));
  const context = initial ? await missionContext(database, initial.runId, userId) : null;
  if (!initial || !context) throw new MissionError('MISSION_NOT_FOUND');
  const available = new ToolRegistry(tools.list().map((tool) => tools.get(tool.name)));
  for (const tool of [...s2aTools(), ...createMcpTools(() => getSettings().advanced.value.mcp)])
    if (!available.list().some((entry) => entry.name === tool.name)) available.register(tool);
  if (!available.list().some((tool) => tool.name === 'project.activity'))
    available.register(createProjectActivityTool(database));
  if (!available.list().some((tool) => tool.name === 'workflow.run'))
    available.register(createWorkflowInvocationTool(database, getSettings));
  for (const tool of createWorkflowControlTools(database))
    if (!available.list().some((entry) => entry.name === tool.name)) available.register(tool);
  for (const tool of mcpTools(await selectedMcp(database, context.run.id), context.run.agentId))
    if (!available.list().some((entry) => entry.name === tool.name)) available.register(tool);
  for (const tool of bridgeTools(
    await selectedBridge(database, context.run.id),
    context.run.agentId,
  ))
    if (!available.list().some((entry) => entry.name === tool.name)) available.register(tool);
  await database.orm.transaction(async (tx) => {
    const [approval] = await tx
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .for('update');
    const [run] = await tx.select().from(runs).where(eq(runs.id, context.run.id)).for('update');
    if (!approval || !run || approval.version !== command.version || approval.status !== 'pending')
      throw new MissionError('MISSION_CONFLICT');
    if (approval.expiresAt.getTime() <= Date.now()) throw new MissionError('APPROVAL_EXPIRED');
    if (run.claimKey) throw new MissionError('MISSION_BUSY');
    if (run.status !== 'waiting_approval') throw new MissionError('MISSION_CONFLICT');
    const state = durableCheckpointSchema.parse(run.checkpoint);
    const call = state.loop.pendingCalls[state.loop.nextCall];
    if (
      !call ||
      approval.callKey !== `${run.id}:${state.loop.step}:${state.loop.nextCall}` ||
      approval.argsHash !== valueHash(call.args)
    )
      throw new MissionError('APPROVAL_INVALID');
    const tool = available.get(call.name);
    const args =
      command.action === 'edit_approve' ? available.parseArgs(call.name, command.args) : call.args;
    if (
      approval.kind === 'uncertain' &&
      !['confirm_done', 'confirm_not_done', 'deny'].includes(command.action)
    )
      throw new MissionError('APPROVAL_INVALID');
    if (approval.kind === 'policy' && ['confirm_done', 'confirm_not_done'].includes(command.action))
      throw new MissionError('APPROVAL_INVALID');
    if (command.action !== 'deny' && command.action !== 'confirm_done') {
      const [learned] = await tx
        .select({ enabled: skills.enabled })
        .from(learnedReplays)
        .innerJoin(skills, eq(skills.id, learnedReplays.skillId))
        .where(eq(learnedReplays.runId, run.id));
      if (learned && !learned.enabled) throw new MissionError('APPROVAL_INVALID');
      const setting = getSettings();
      const decision = evaluatePolicy({
        ...(await inheritedRecipePolicy(database, run.id, context.mission.recipePolicy)),
        tool: call.name,
        args,
        effect: tool.effect,
        effectKnown: tool.effectKnown,
        scope: tool.scope,
        ...(tool.connector ? { connector: tool.connector } : {}),
        moneyMovement: tool.moneyMovement ?? false,
        agentId: run.agentId,
        projectId: context.project.id,
        tainted: state.loop.tainted,
        preset: setting.security.value.preset,
        rules: setting.security.value.rules,
      });
      const agent = agentRoleSchema.parse(run.agentId);
      const control =
        isWorkflowControl(run.workflowNode, call.name) || isS2aControl(state.workflow, call.name);
      if (
        (state.workflow && !workflowAllows(state.workflow, call.name)) ||
        (!state.workflow && call.name.startsWith('s2a.')) ||
        (call.name.startsWith('mcp_connection.') &&
          !setting.advanced.value.mcp.some(
            (connection) =>
              connection.enabled &&
              connection.agents.includes(agent) &&
              connection.tools.some(
                (entry) => entry.enabled && mcpToolName(connection.id, entry.name) === call.name,
              ),
          ))
      )
        throw new MissionError('APPROVAL_INVALID');
      if (control) {
        const identities = [
          await runAgent(database, userId, run.id, agent),
          (await getAgent(database, userId, agent)).definition,
        ];
        if (
          identities.some(
            (identity) => !identity.enabled || matchesTool(identity.permissions.deny, call.name),
          )
        )
          throw new MissionError('APPROVAL_INVALID');
      }
      if (
        !control &&
        (await hasPinnedAgent(database, run.id, agent)) &&
        !(await agentActionPermission(
          database,
          userId,
          run.id,
          agent,
          call.name,
          args,
          tool.effect,
          setting.connectors.value.accounts,
        ))
      )
        throw new MissionError('APPROVAL_INVALID');
      if (decision.action === 'deny') throw new MissionError('APPROVAL_INVALID');
      if (
        call.name.startsWith('mcp.') &&
        !(await mcpActionAllowed(database, run.id, agent, call.name))
      )
        throw new MissionError('APPROVAL_INVALID');
      if (
        call.name.startsWith('local.') &&
        !(await bridgeActionAllowed(database, run.id, agent, call.name, args))
      )
        throw new MissionError('APPROVAL_INVALID');
    }
    if (command.action === 'edit_approve') {
      call.args = args;
      for (const message of state.loop.messages)
        if (message.role === 'assistant')
          for (const prior of message.toolCalls ?? []) if (prior.id === call.id) prior.args = args;
    }
    if (approval.kind === 'uncertain') await resolveUncertainty(tx, approval, command);
    const reviewRequired =
      command.action === 'edit_approve' &&
      tool.scope === 'external' &&
      tool.effect !== 'read' &&
      (await projectReview(database, userId, context.project.id)).mode !== 'off';
    const status =
      command.action === 'deny'
        ? 'denied'
        : approval.kind === 'uncertain'
          ? 'resolved'
          : reviewRequired
            ? 'reviewing'
            : 'approved';
    await tx
      .update(approvals)
      .set({
        status,
        args: jsonValue(args),
        argsHash: valueHash(args),
        note: command.note,
        decision: command.action,
        decidedBy: userId,
        version: approval.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, approvalId));
    await tx
      .update(runs)
      .set({
        checkpoint: jsonValue(state),
        status: 'queued',
        reason: null,
        version: run.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(runs.id, run.id));
    await enqueueRun(tx, run.id);
    await tx.insert(auditLog).values({
      id: workKey('aud'),
      actorId: userId,
      action: `approval.${command.action}`,
      target: approvalId,
    });
  });
  const [row] = await database.orm.select().from(approvals).where(eq(approvals.id, approvalId));
  return publicApproval(row!, context.mission);
}
async function resolveUncertainty(
  tx: Transaction,
  approval: typeof approvals.$inferSelect,
  command: ApprovalDecision,
) {
  if (command.action === 'confirm_not_done')
    await tx
      .update(toolCalls)
      .set({ status: 'retry_ready', updatedAt: new Date() })
      .where(eq(toolCalls.idempotencyKey, approval.callKey));
  else
    await tx
      .update(toolCalls)
      .set({
        status: 'done',
        result: jsonValue({
          output:
            command.action === 'confirm_done'
              ? { confirmedByUser: true, note: command.note }
              : { cancelledByUser: true, outcome: 'unknown', note: command.note },
          untrusted: false,
        }),
        updatedAt: new Date(),
      })
      .where(eq(toolCalls.idempotencyKey, approval.callKey));
}
