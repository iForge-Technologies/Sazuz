import { z } from 'zod';
import { SazuzError } from './errors';
import { workId } from './work';
import { agentRoleSchema, triggerConfigSchema, recipePolicySchema } from './missions';

export const workflowKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
export const workflowExpression = z.string().trim().min(1).max(4000);
export const workflowData = z.json().refine((value) => JSON.stringify(value).length <= 32_000);
export const workflowObjectSchema = z.record(z.string().max(128), z.json());
export const workflowTriggerSchema = z.union([
  z.strictObject({ kind: z.literal('manual') }),
  triggerConfigSchema,
]);
const reference = {
  workflowId: workId,
  revision: z.number().int().positive(),
};
export const workflowActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('trigger'), trigger: workflowTriggerSchema }),
  z.strictObject({
    kind: z.literal('tool'),
    agent: agentRoleSchema,
    tool: z
      .string()
      .max(128)
      .regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/),
  }),
  z.strictObject({
    kind: z.literal('agent'),
    agent: agentRoleSchema,
    prompt: z.string().trim().min(1).max(8000),
    outputSchema: workflowObjectSchema,
  }),
  z.strictObject({
    kind: z.literal('skill'),
    agent: agentRoleSchema,
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    revision: z.number().int().positive(),
    prompt: z.string().trim().min(1).max(8000),
    outputSchema: workflowObjectSchema,
  }),
  z.strictObject({
    kind: z.literal('condition'),
    expression: workflowExpression,
  }),
  z.strictObject({
    kind: z.literal('classify'),
    prompt: z.string().trim().min(1).max(4000),
    branches: z
      .array(workflowKey)
      .min(2)
      .max(8)
      .refine((v) => new Set(v).size === v.length),
  }),
  z.strictObject({
    kind: z.literal('map'),
    ...reference,
    items: workflowExpression,
    concurrency: z.number().int().min(1).max(4),
  }),
  z.strictObject({ kind: z.literal('parallel') }),
  z.strictObject({ kind: z.literal('approval'), message: z.string().trim().min(1).max(2000) }),
  z.strictObject({
    kind: z.literal('wait'),
    until: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('duration'), seconds: z.number().int().min(1).max(86400) }),
      z.strictObject({ kind: z.literal('time'), at: z.iso.datetime() }),
      z.strictObject({ kind: z.literal('event'), name: workflowKey }),
    ]),
  }),
  z.strictObject({ kind: z.literal('transform'), expression: workflowExpression }),
  z.strictObject({ kind: z.literal('notify') }),
  z.strictObject({ kind: z.literal('workflow'), ...reference }),
]);
export type WorkflowAction = z.infer<typeof workflowActionSchema>;
export const workflowNodeSchema = z.strictObject({
  id: workflowKey,
  label: z.string().trim().min(1).max(100),
  position: z.strictObject({
    x: z.number().finite().min(-10000).max(10000),
    y: z.number().finite().min(-10000).max(10000),
  }),
  input: workflowExpression.default('$input'),
  action: workflowActionSchema,
  retry: z
    .strictObject({
      attempts: z.number().int().min(1).max(3),
      delaySeconds: z.number().int().min(0).max(3600),
      timeoutSeconds: z.number().int().min(1).max(86400),
    })
    .default({ attempts: 1, delaySeconds: 1, timeoutSeconds: 300 }),
  pin: workflowData.nullable().default(null),
});
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export const workflowDefinitionSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(160),
    description: z.string().max(2000).default(''),
    concurrency: z.number().int().min(1).max(4).default(2),
    policy: recipePolicySchema.nullable().default(null),
    nodes: z.array(workflowNodeSchema).min(1).max(64),
    edges: z
      .array(
        z.strictObject({
          from: workflowKey,
          to: workflowKey,
          branch: workflowKey.optional(),
        }),
      )
      .max(192),
  })
  .superRefine((graph, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
    const ids = new Set(graph.nodes.map((n) => n.id));
    if (ids.size !== graph.nodes.length) invalid('Node IDs must be unique.');
    const triggers = graph.nodes.filter((n) => n.action.kind === 'trigger');
    if (triggers.length !== 1) invalid('Exactly one trigger is required.');
    const edgeIds = new Set<string>();
    for (const edge of graph.edges) {
      const key = `${edge.from}:${edge.to}:${edge.branch ?? ''}`;
      if (!ids.has(edge.from) || !ids.has(edge.to) || edgeIds.has(key))
        invalid('Invalid or duplicate edge.');
      edgeIds.add(key);
      const source = graph.nodes.find((n) => n.id === edge.from)?.action;
      const branches =
        source?.kind === 'classify'
          ? source.branches
          : source?.kind === 'condition'
            ? ['true', 'false']
            : [];
      if (edge.branch && !branches.includes(edge.branch))
        invalid('The edge branch is unavailable.');
      if (branches.length && !edge.branch) invalid('Condition edges require a named branch.');
      if (edge.to === triggers[0]?.id) invalid('A trigger cannot have incoming edges.');
    }
    const pending = new Set(ids),
      complete = new Set<string>();
    while (pending.size) {
      const ready = [...pending].filter((id) =>
        graph.edges.filter((e) => e.to === id).every((e) => complete.has(e.from)),
      );
      if (!ready.length) {
        invalid('Workflow cycles are not allowed. Use a bounded Map.');
        break;
      }
      for (const id of ready) {
        pending.delete(id);
        complete.add(id);
      }
    }
    for (const node of graph.nodes)
      if (node.action.kind !== 'trigger' && !graph.edges.some((e) => e.to === node.id))
        invalid('Every node must be connected to the trigger.');
    if (JSON.stringify(graph).length > 100_000) invalid('Workflow exceeds the size limit.');
  });
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export const workflowWriteSchema = z.strictObject({
  projectId: workId,
  expectedVersion: z.number().int().nonnegative(),
  definition: workflowDefinitionSchema,
});
export const workflowReviewSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  revision: z.number().int().positive(),
  enabled: z.boolean(),
});
export const workflowRunInputSchema = z.strictObject({
  requestId: z.uuid(),
  revision: z.number().int().positive(),
  input: workflowData.default({}),
  test: z.boolean().default(false),
});
export const workflowEventSchema = z.strictObject({
  requestId: z.uuid(),
  name: workflowKey,
  data: workflowData,
});
export const workflowSchema = z.strictObject({
  id: workId,
  projectId: workId,
  version: z.number().int().positive(),
  revision: z.number().int().positive(),
  activeRevision: z.number().int().positive().nullable(),
  enabled: z.boolean(),
  definition: workflowDefinitionSchema,
  triggerId: workId.nullable(),
  updatedAt: z.iso.datetime(),
});
export type Workflow = z.infer<typeof workflowSchema>;
export const workflowSnapshotSchema = z.record(z.string().max(100), workflowDefinitionSchema);
export const workflowNodeExecutionSchema = z.strictObject({
  workflowRunId: workId,
  nodeId: workId,
  action: workflowActionSchema,
  goal: z.string().max(16000),
  input: workflowData,
  startedAt: z.iso.datetime(),
  deadline: z.iso.datetime(),
  toolsOnly: z.boolean(),
  privateOnly: z.boolean(),
  modelFree: z.boolean(),
  test: z.boolean(),
});
export type WorkflowNodeExecution = z.infer<typeof workflowNodeExecutionSchema>;
export const workflowRunSchema = z.strictObject({
  id: workId,
  workflowId: workId,
  revision: z.number().int().positive(),
  missionId: workId,
  status: z.string(),
  input: workflowData,
  output: workflowData.nullable(),
  test: z.boolean(),
  modelFree: z.boolean(),
  tainted: z.boolean(),
  privateOnly: z.boolean(),
  createdAt: z.iso.datetime(),
  nodes: z.array(
    z.strictObject({
      id: workId,
      key: workflowKey,
      attempt: z.number().int().positive(),
      status: z.string(),
      runId: workId.nullable(),
      input: workflowData.nullable(),
      output: workflowData.nullable(),
      branch: z.string().nullable(),
      reason: z.string().nullable(),
      tainted: z.boolean(),
      privateOnly: z.boolean(),
      pinned: z.boolean(),
    }),
  ),
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;
export const workflowDraftInputSchema = z.strictObject({
  projectId: workId,
  requestId: z.uuid(),
  prompt: z.string().trim().min(10).max(4000),
  privateOnly: z.boolean().default(false),
});
export const workflowDraftSchema = z.strictObject({
  id: workId,
  projectId: workId,
  requestId: z.uuid(),
  status: z.enum(['generating', 'ready', 'failed']),
  definition: workflowDefinitionSchema.nullable(),
  privateOnly: z.boolean(),
  costUsd: z.number().nonnegative(),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export const workflowInvokeSchema = z.strictObject({
  workflowId: workId,
  revision: z.number().int().positive(),
  input: workflowData.default({}),
});
export const workflowInvocationSchema = z.strictObject({
  runId: workId,
  workflowId: workId,
  revision: z.number().int().positive(),
});
export class WorkflowError extends SazuzError {
  constructor(
    code:
      | 'WORKFLOW_INVALID'
      | 'WORKFLOW_NOT_FOUND'
      | 'WORKFLOW_CONFLICT'
      | 'WORKFLOW_UNREVIEWED'
      | 'WORKFLOW_EXPRESSION'
      | 'WORKFLOW_LIMIT'
      | 'WORKFLOW_MODEL_FREE',
  ) {
    super(
      code,
      {
        WORKFLOW_INVALID:
          'Check the workflow graph, inputs and permissions. Keep credentials in the vault.',
        WORKFLOW_NOT_FOUND: 'This workflow or revision is unavailable in the project.',
        WORKFLOW_CONFLICT: 'The workflow changed. Reload and review the exact revision.',
        WORKFLOW_UNREVIEWED:
          'Review this workflow revision before running or enabling its trigger.',
        WORKFLOW_EXPRESSION: 'The expression is invalid or exceeds its safe evaluation limits.',
        WORKFLOW_LIMIT: 'The workflow exceeded its graph, data or execution allowance.',
        WORKFLOW_MODEL_FREE:
          'This workflow forbids model calls. Project Auditor review requires inference; change the project review setting or add an explicit agent step.',
      }[code],
    );
  }
}
