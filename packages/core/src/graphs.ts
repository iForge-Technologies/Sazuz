import { z } from 'zod';
import { agentRoleSchema } from './agents';
import { workId } from './work';

/** The Phase 3 sequential format remains readable for durable runs and learned provenance. */
export const sequentialPlanSchema = z.strictObject({
  tasks: z
    .array(
      z.strictObject({
        agent: z.enum(['researcher', 'comms', 'coder', 'analyst', 'operator']),
        goal: z.string().min(1).max(8000),
        acceptance: z.array(z.string().min(1).max(1000)).max(10),
      }),
    )
    .max(3),
  deliverable: z.string().min(1).max(2000),
});

export const taskKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
export const taskBudgetSchema = z.strictObject({
  usd: z.number().finite().min(0).max(10000),
  steps: z.number().int().min(1).max(1000),
});
export const graphTaskSchema = z.strictObject({
  id: taskKeySchema,
  agent: agentRoleSchema.exclude(['cos', 'auditor']),
  goal: z.string().trim().min(1).max(8000),
  inputs: z
    .record(z.string().max(100), z.json())
    .refine((value) => JSON.stringify(value).length <= 12000),
  depends_on: z.array(taskKeySchema).max(24),
  acceptance: z.array(z.string().trim().min(1).max(1000)).min(1).max(10),
  budget: taskBudgetSchema,
});
export const graphPlanSchema = z
  .strictObject({
    mode: z.enum(['answer', 'single', 'graph']),
    tasks: z.array(graphTaskSchema).max(24),
    user_checkpoints: z.array(z.string().trim().min(1).max(500)).max(10),
    deliverable: z.string().trim().min(1).max(2000),
  })
  .superRefine((plan, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (
      (plan.mode === 'answer' && plan.tasks.length !== 0) ||
      (plan.mode === 'single' && plan.tasks.length !== 1) ||
      (plan.mode === 'graph' && plan.tasks.length < 2)
    )
      invalid('Mode must match the number of tasks.');
    const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
    if (tasks.size !== plan.tasks.length) invalid('Task IDs must be unique.');
    const visited = new Set<string>(),
      visiting = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (visited.has(id)) return true;
      const task = tasks.get(id);
      if (!task || new Set(task.depends_on).size !== task.depends_on.length) return false;
      visiting.add(id);
      for (const dependency of task.depends_on) if (!visit(dependency)) return false;
      visiting.delete(id);
      visited.add(id);
      return true;
    };
    if (plan.tasks.some((task) => !visit(task.id)))
      invalid('Dependencies must exist and form a DAG.');
  });
export type GraphPlan = z.infer<typeof graphPlanSchema>;
export type GraphTask = z.infer<typeof graphTaskSchema>;

export const taskResultSchema = z.strictObject({
  taskId: taskKeySchema,
  agent: agentRoleSchema,
  text: z.string().max(100000),
  tainted: z.boolean(),
  privateOnly: z.boolean(),
});
export const taskAssignmentSchema = z.strictObject({
  taskId: workId,
  taskKey: taskKeySchema,
  attempt: z.number().int().min(1).max(3),
  task: graphTaskSchema,
  dependencies: z.array(taskResultSchema).max(24),
  feedback: z.string().max(8000).nullable(),
  userCheckpoints: z.array(z.string().max(500)).max(10),
  startedAt: z.iso.datetime(),
  tainted: z.boolean(),
  privateOnly: z.boolean(),
});
export type TaskAssignment = z.infer<typeof taskAssignmentSchema>;
export const replanSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('revise'),
    taskId: taskKeySchema,
    agent: graphTaskSchema.shape.agent,
    goal: z.string().trim().min(1).max(8000),
    reason: z.string().trim().min(1).max(2000),
  }),
  z.strictObject({ action: z.literal('ask_user'), question: z.string().trim().min(1).max(2000) }),
]);
export type Replan = z.infer<typeof replanSchema>;
export const agentMessageTypeSchema = z.enum([
  'assign',
  'progress',
  'result',
  'question',
  'handoff',
  'escalate',
  'review_request',
  'review_verdict',
]);
export const teamMessageInputSchema = z.strictObject({
  type: z.enum(['progress', 'question', 'handoff', 'escalate']),
  to: z.union([agentRoleSchema, z.literal('user')]),
  content: z.string().trim().min(1).max(4000),
});
export const blackboardInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(8000),
  artifacts: z.array(workId).max(20).default([]),
});
export const blackboardEntrySchema = z.strictObject({
  id: workId,
  runId: workId.nullable(),
  agentId: z.union([agentRoleSchema, z.literal('user')]),
  text: z.string(),
  artifacts: z.array(workId),
  tainted: z.boolean(),
  privateOnly: z.boolean(),
  createdAt: z.iso.datetime(),
});
export const graphViewSchema = z.strictObject({
  revision: z.number().int().positive(),
  plan: graphPlanSchema,
  revisions: z.array(
    z.strictObject({
      revision: z.number().int().positive(),
      reason: z.string(),
      createdAt: z.iso.datetime(),
    }),
  ),
  tasks: z.array(
    z.strictObject({
      id: workId,
      key: taskKeySchema,
      definition: graphTaskSchema,
      status: z.enum([
        'pending',
        'queued',
        'running',
        'waiting_approval',
        'paused',
        'budget_exceeded',
        'completed',
        'failed',
        'cancelled',
        'rejected',
      ]),
      attempt: z.number().int().nonnegative(),
      runId: workId.nullable(),
      feedback: z.string().nullable(),
      result: taskResultSchema.nullable(),
      steps: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
    }),
  ),
});
export type GraphView = z.infer<typeof graphViewSchema>;
export const missionReplySchema = z.strictObject({
  runId: workId,
  version: z.number().int().positive(),
  text: z.string().trim().min(1).max(8000),
  requestId: z.uuid(),
});
