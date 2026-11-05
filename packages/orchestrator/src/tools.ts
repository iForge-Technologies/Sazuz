import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  blackboardInputSchema,
  blackboardEntrySchema,
  teamMessageInputSchema,
} from '@sazuz/core/graphs';
import {
  agentMessages,
  artifacts,
  blackboardEntries,
  runs,
  missionBlackboard,
  workKey,
  jsonValue,
  type Database,
} from '@sazuz/db';
import { defineTool, type ToolContext } from '@sazuz/tools';
import { activeAssignment } from './graphs.js';
import { runAgent } from './agents.js';
import { OrchestrationError } from './errors.js';

async function scope(db: Database, tool: ToolContext) {
  const value = await activeAssignment(db, tool.runId);
  if (
    value.context.project.id !== tool.projectId ||
    value.role !== tool.agentId ||
    value.context.run.claimKey !== tool.claimKey
  )
    throw new OrchestrationError('GRAPH_NOT_FOUND');
  return value;
}
export function createMissionTools(db: Database) {
  return [
    defineTool({
      name: 'blackboard.read',
      description: 'Read the most recent shared notes and artifact handles in this mission.',
      input: z.strictObject({}),
      output: z.array(blackboardEntrySchema),
      effect: 'read',
      scope: 'internal',
      untrusted: true,
      privateOnly: (notes) => notes.some((note) => note.privateOnly),
      run: async (tool) => {
        const { context } = await scope(db, tool);
        return missionBlackboard(db, context.project.userId, context.mission.id);
      },
    }),
    defineTool({
      name: 'blackboard.append',
      description:
        'Append a shared mission note, optionally referencing artifacts from this mission. Notes never alter the task graph.',
      input: blackboardInputSchema,
      output: z.strictObject({ id: z.string() }),
      effect: 'write',
      scope: 'internal',
      untrusted: true,
      verify: async (tool) => {
        const { context } = await scope(db, tool);
        const [note] = await db.orm
          .select()
          .from(blackboardEntries)
          .where(
            and(
              eq(blackboardEntries.missionId, context.mission.id),
              eq(blackboardEntries.eventKey, tool.idempotencyKey),
            ),
          );
        return note ? { status: 'done', result: { id: note.id } } : { status: 'not_done' };
      },
      run: async (tool, args) => {
        const { context, role } = await scope(db, tool);
        const privateOnly =
          context.project.privacy === 'private' ||
          (z
            .object({ loop: z.object({ privateOnly: z.boolean().default(false) }) })
            .safeParse(context.run.checkpoint).data?.loop.privateOnly ??
            false);
        return db.orm.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${context.mission.id + ':blackboard'},6))`,
          );
          for (const id of args.artifacts) {
            const [artifact] = await tx
              .select({ id: artifacts.id })
              .from(artifacts)
              .innerJoin(runs, eq(runs.id, artifacts.runId))
              .where(and(eq(artifacts.id, id), eq(runs.missionId, context.mission.id)));
            if (!artifact) throw new OrchestrationError('GRAPH_NOT_FOUND');
          }
          const [existing] = await tx
            .select()
            .from(blackboardEntries)
            .where(
              and(
                eq(blackboardEntries.missionId, context.mission.id),
                eq(blackboardEntries.eventKey, tool.idempotencyKey),
              ),
            );
          if (existing) return { id: existing.id };
          const count = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(blackboardEntries)
            .where(eq(blackboardEntries.missionId, context.mission.id));
          if (count[0]!.count >= 1000) throw new OrchestrationError('GRAPH_BUDGET');
          const id = workKey('bbn');
          await tx.insert(blackboardEntries).values({
            id,
            missionId: context.mission.id,
            runId: tool.runId,
            agentId: role,
            eventKey: tool.idempotencyKey,
            text: args.text,
            artifacts: jsonValue(args.artifacts),
            privateOnly,
          });
          await tx.execute(sql`SELECT pg_notify('execution_changed',${context.mission.id})`);
          return { id };
        });
      },
    }),
    defineTool({
      name: 'team.message',
      description:
        'Record progress, a question, an escalation or a suggested handoff. Only CoS revises tasks. Questions to the user pause this run for a reply.',
      input: teamMessageInputSchema,
      output: z.strictObject({ recorded: z.literal(true), questionForUser: z.boolean() }),
      effect: 'write',
      scope: 'internal',
      untrusted: true,
      pause: (result) =>
        result.questionForUser ? 'Waiting for your reply in the mission conversation.' : undefined,
      verify: async (tool, args) => {
        const { context } = await scope(db, tool);
        const [message] = await db.orm
          .select()
          .from(agentMessages)
          .where(
            and(
              eq(agentMessages.missionId, context.mission.id),
              eq(agentMessages.eventKey, tool.idempotencyKey),
            ),
          );
        return message
          ? {
              status: 'done',
              result: {
                recorded: true as const,
                questionForUser: args.type === 'question' && args.to === 'user',
              },
            }
          : { status: 'not_done' };
      },
      run: async (tool, args) => {
        const { context, role, assignment } = await scope(db, tool);
        const definition = await runAgent(db, context.project.userId, tool.runId, role);
        if (args.to !== 'user' && args.to !== 'cos' && !definition.handoff_to.includes(args.to))
          throw new OrchestrationError('AGENT_SCOPE_DENIED');
        await db.orm
          .insert(agentMessages)
          .values({
            id: workKey('agm'),
            missionId: context.mission.id,
            taskId: assignment?.taskKey ?? null,
            eventKey: tool.idempotencyKey,
            from: role,
            to: args.to,
            type: args.type,
            content: args.content,
          })
          .onConflictDoNothing();
        return {
          recorded: true as const,
          questionForUser: args.type === 'question' && args.to === 'user',
        };
      },
    }),
  ];
}
