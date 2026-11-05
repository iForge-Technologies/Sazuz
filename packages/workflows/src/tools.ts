import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineTool } from '@sazuz/tools';
import { missionContext, notifications, workKey, type Database } from '@sazuz/db';
import { workflowNodeExecutionSchema, WorkflowError } from '@sazuz/core/workflows';
import { notificationSignalsSchema } from '@sazuz/core/calm';

/** Fixed owner-reviewed control nodes are not available as agent-selected tools. */
export function isWorkflowControl(metadata: unknown, name: string) {
  const node = workflowNodeExecutionSchema.safeParse(metadata);
  return (
    node.success &&
    ((node.data.action.kind === 'approval' && name === 'workflow.checkpoint') ||
      (node.data.action.kind === 'notify' && name === 'workflow.notify'))
  );
}
export function createWorkflowControlTools(db: Database) {
  return [
    defineTool({
      name: 'workflow.checkpoint',
      description: 'Pause an owner-reviewed workflow for an explicit human checkpoint.',
      input: z.strictObject({ message: z.string().min(1).max(2000) }),
      output: z.strictObject({ approved: z.literal(true) }),
      // Unknown/write intentionally retains ask even under Autonomous.
      scope: 'internal',
      untrusted: false,
      async run(context) {
        const run = await missionContext(db, context.runId);
        if (!run || !isWorkflowControl(run.run.workflowNode, 'workflow.checkpoint'))
          throw new WorkflowError('WORKFLOW_INVALID');
        return { approved: true as const };
      },
      verify: () =>
        Promise.resolve({ status: 'done' as const, result: { approved: true as const } }),
    }),
    defineTool({
      name: 'workflow.notify',
      description:
        'Queue a reviewed workflow notification to its owner through Calm Mode and paired channel preferences.',
      input: z.strictObject({
        level: z.enum(['urgent', 'normal', 'low']),
        title: z.string().min(1).max(160),
        body: z.string().max(16000),
        signals: notificationSignalsSchema.default({}),
      }),
      output: z.strictObject({ notificationId: z.string() }),
      effect: 'send',
      scope: 'internal',
      untrusted: false,
      async run(context, args) {
        const run = await missionContext(db, context.runId);
        if (!run || !isWorkflowControl(run.run.workflowNode, 'workflow.notify'))
          throw new WorkflowError('WORKFLOW_INVALID');
        await db.orm
          .insert(notifications)
          .values({
            id: workKey('ntf'),
            eventKey: `workflow:${context.idempotencyKey}`,
            userId: run.project.userId,
            projectId: run.project.id,
            missionId: run.mission.id,
            sourceRunId: run.run.id,
            ...args,
          })
          .onConflictDoNothing();
        const [row] = await db.orm
          .select({ id: notifications.id })
          .from(notifications)
          .where(eq(notifications.eventKey, `workflow:${context.idempotencyKey}`));
        return { notificationId: row!.id };
      },
      async verify(context) {
        const [row] = await db.orm
          .select({ id: notifications.id })
          .from(notifications)
          .where(eq(notifications.eventKey, `workflow:${context.idempotencyKey}`));
        return row
          ? { status: 'done' as const, result: { notificationId: row.id } }
          : { status: 'not_done' as const };
      },
    }),
  ];
}
