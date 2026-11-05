import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { llmMessageSchema } from '@sazuz/llm';
import { secretRedactor } from '@sazuz/vault';
import { missionReplySchema } from '@sazuz/core/graphs';
import {
  agentMessages,
  runs,
  missionTasks,
  missionContext,
  getControl,
  enqueueRun,
  wakeParent,
  MissionError,
  jsonValue,
  workKey,
  type Database,
} from '@sazuz/db';

export async function replyToMission(
  db: Database,
  userId: string,
  missionId: string,
  input: unknown,
) {
  const reply = missionReplySchema.parse(input);
  const context = await missionContext(db, reply.runId, userId);
  if (!context || context.mission.id !== missionId) throw new MissionError('MISSION_NOT_FOUND');
  if ((await getControl(db)).paused) throw new MissionError('EXECUTION_PAUSED');
  const text = secretRedactor.redactText(reply.text);
  await db.orm.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, reply.runId)).for('update');
    if (
      (
        await tx
          .select()
          .from(agentMessages)
          .where(
            and(
              eq(agentMessages.missionId, missionId),
              eq(agentMessages.eventKey, 'reply:' + reply.requestId),
            ),
          )
      ).length
    )
      return;
    if (!run || run.version !== reply.version || run.status !== 'paused' || run.claimKey)
      throw new MissionError('MISSION_CONFLICT');
    const checkpoint = z
      .looseObject({
        loop: z.looseObject({
          messages: z.array(llmMessageSchema),
          status: z.string(),
          reason: z.string().nullable(),
        }),
      })
      .parse(run.checkpoint);
    checkpoint.loop.messages.push({ role: 'user', content: text });
    checkpoint.loop.status = 'running';
    checkpoint.loop.reason = null;
    await tx
      .update(runs)
      .set({
        status: 'queued',
        reason: null,
        checkpoint: jsonValue(checkpoint),
        version: run.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(runs.id, run.id));
    await tx
      .update(missionTasks)
      .set({
        feedback: sql`coalesce(${missionTasks.feedback},'') || ${'\nOwner reply: ' + text}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(missionTasks.missionId, missionId),
          sql`${missionTasks.status} IN ('failed','rejected')`,
        ),
      );
    await tx.insert(agentMessages).values({
      id: workKey('agm'),
      missionId,
      eventKey: 'reply:' + reply.requestId,
      from: 'user',
      to: run.agentId,
      type: 'result',
      content: text,
      payload: jsonValue({ runId: run.id }),
    });
    await enqueueRun(tx, run.id);
    await wakeParent(tx, run.parentRunId);
    if (!run.parentRunId) {
      const children = await tx
        .update(runs)
        .set({
          status: 'queued',
          reason: null,
          updatedAt: new Date(),
          version: sql`${runs.version}+1`,
        })
        .where(
          and(
            eq(runs.parentRunId, run.id),
            eq(runs.status, 'paused'),
            eq(runs.reason, 'Stopped with the parent mission.'),
          ),
        )
        .returning({ id: runs.id });
      for (const child of children) await enqueueRun(tx, child.id);
    }
    await tx.execute(sql`SELECT pg_notify('execution_changed',${run.id})`);
  });
  return { recorded: true as const };
}
