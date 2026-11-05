import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { z } from 'zod';
import {
  projectInput,
  projectSchema,
  threadInput,
  threadSchema,
  messageSchema,
} from '@sazuz/core/work';
import { secretRedactor } from '@sazuz/vault';
import type { Database } from './client.js';
import { projects, threads, messages, costLedger } from './schema.js';
import { utcCostPeriod } from '@sazuz/core/observability';

const publicProject = (row: typeof projects.$inferSelect) =>
  projectSchema.parse({
    id: row.id,
    name: row.name,
    brief: row.brief,
    privacy: row.privacy,
    budgetUsd: row.budgetUsd,
    createdAt: row.createdAt.toISOString(),
  });

export async function listProjects(db: Database, userId: string) {
  return (
    await db.orm
      .select()
      .from(projects)
      .where(eq(projects.userId, userId))
      .orderBy(asc(projects.createdAt))
  ).map(publicProject);
}
export async function createProject(db: Database, userId: string, input: unknown) {
  const value = projectInput.parse(input);
  const [row] = await db.orm
    .insert(projects)
    .values({
      id: `prj_${ulid()}`,
      userId,
      ...value,
      name: secretRedactor.redactText(value.name),
      brief: secretRedactor.redactText(value.brief),
    })
    .returning();
  return publicProject(row!);
}
export async function ownedProject(db: Database, userId: string, id: string) {
  const [row] = await db.orm
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, userId)));
  return row;
}
export async function createThread(db: Database, userId: string, input: unknown) {
  const value = threadInput.parse(input);
  if (!(await ownedProject(db, userId, value.projectId))) return null;
  const [row] = await db.orm
    .insert(threads)
    .values({ id: `thr_${ulid()}`, ...value, title: secretRedactor.redactText(value.title) })
    .returning();
  return threadSchema.parse({ ...row, createdAt: row!.createdAt.toISOString() });
}
export async function listThreads(db: Database, userId: string, projectId: string) {
  if (!(await ownedProject(db, userId, projectId))) return [];
  return (
    await db.orm
      .select()
      .from(threads)
      .where(eq(threads.projectId, projectId))
      .orderBy(asc(threads.createdAt))
  ).map((row) => threadSchema.parse({ ...row, createdAt: row.createdAt.toISOString() }));
}
export async function threadContext(db: Database, userId: string, threadId: string) {
  const [row] = await db.orm
    .select({ thread: threads, project: projects })
    .from(threads)
    .innerJoin(projects, eq(threads.projectId, projects.id))
    .where(and(eq(threads.id, threadId), eq(projects.userId, userId)));
  return row;
}
export const publicMessage = (row: typeof messages.$inferSelect) =>
  messageSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
export async function readMessages(db: Database, threadId: string) {
  return (
    await db.orm
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(500)
  ).reverse();
}
export async function addMessage(db: Database, input: typeof messages.$inferInsert) {
  const [row] = await db.orm
    .insert(messages)
    .values({
      ...input,
      content: secretRedactor.redactText(input.content),
      toolCalls: secretRedactor.redact(input.toolCalls ?? []),
    })
    .onConflictDoNothing()
    .returning();
  return row;
}
export async function costTotals(db: Database, projectId?: string) {
  const query = projectId ? sql`WHERE project_id=${projectId}` : sql``;
  const result = await db.orm.execute(
    sql`SELECT COALESCE(sum(cost_usd),0)::float8 AS "totalUsd", COALESCE(sum(input_tokens),0)::float8 AS "inputTokens", COALESCE(sum(output_tokens),0)::float8 AS "outputTokens" FROM cost_ledger ${query}`,
  );
  return z
    .object({ totalUsd: z.number(), inputTokens: z.number(), outputTokens: z.number() })
    .parse(result.rows[0]);
}
export async function remainingSpend(
  db: Database,
  caps: { dailyUsd: number; monthlyUsd: number },
  projectId?: string,
  projectCap = Number.POSITIVE_INFINITY,
  now = new Date(),
) {
  const period = utcCostPeriod(now);
  const result = await db.orm.execute(
    sql`SELECT COALESCE(sum(cost_usd) FILTER (WHERE created_at >= ${period.day}),0)::float8 AS daily, COALESCE(sum(cost_usd) FILTER (WHERE created_at >= ${period.start}),0)::float8 AS monthly, COALESCE(sum(cost_usd) FILTER (WHERE project_id=${projectId ?? null}),0)::float8 AS project FROM cost_ledger WHERE created_at <= ${now}`,
  );
  const spent = z
    .object({ daily: z.number(), monthly: z.number(), project: z.number() })
    .parse(result.rows[0]);
  return Math.min(
    caps.dailyUsd - spent.daily,
    caps.monthlyUsd - spent.monthly,
    projectCap - spent.project,
  );
}
export async function recordCost(db: Database, input: typeof costLedger.$inferInsert) {
  await db.orm.insert(costLedger).values(input);
}
