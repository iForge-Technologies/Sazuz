import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { secretRedactor } from '@sazuz/vault';
import type { SettingsDocument } from '@sazuz/config/settings';
import {
  costDashboardSchema,
  costGroupSchema,
  costSummarySchema,
  costThreshold,
  utcCostPeriod,
} from '@sazuz/core/observability';
import type { Database } from './client.js';
import { costAlerts, notifications, projects } from './schema.js';
import { MissionError, valueHash, workKey } from './missions.js';

/** Unscoped calls belong to the installation owner; project calls keep their ownership. */
export const ownedLedger = (userId: string) =>
  sql`(p.user_id = ${userId} OR (c.project_id IS NULL AND EXISTS (SELECT 1 FROM installation i WHERE i.admin_id = ${userId})))`;
const metrics = sql`COALESCE(sum(c.cost_usd),0)::float8 AS "costUsd", count(*)::int AS calls,
  COALESCE(sum(c.input_tokens),0)::float8 AS "inputTokens", COALESCE(sum(c.output_tokens),0)::float8 AS "outputTokens",
  count(*) FILTER (WHERE c.status <> 'completed')::int AS "failedCalls", count(*) FILTER (WHERE c.estimated)::int AS "estimatedCalls"`;

export async function costDashboard(
  db: Database,
  userId: string,
  settings: SettingsDocument,
  projectId?: string,
  now = new Date(),
) {
  const [project] = projectId
    ? await db.orm
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    : [];
  if (projectId && !project) throw new MissionError('MISSION_NOT_FOUND');
  const period = utcCostPeriod(now);
  const owner = sql`${ownedLedger(userId)} ${projectId ? sql`AND c.project_id = ${projectId}` : sql``} AND c.created_at <= ${now}`;
  const total = await db.orm.execute(
    sql`SELECT ${metrics} FROM cost_ledger c LEFT JOIN projects p ON p.id=c.project_id WHERE ${owner} AND c.created_at >= ${period.start}`,
  );
  const summary = costSummarySchema.parse(total.rows[0]);
  const other = await db.orm.execute(
    sql`SELECT COALESCE(sum(c.cost_usd),0)::float8 AS "allTimeUsd", COALESCE(sum(c.cost_usd) FILTER (WHERE c.created_at >= ${period.day}),0)::float8 AS "todayUsd" FROM cost_ledger c LEFT JOIN projects p ON p.id=c.project_id WHERE ${owner}`,
  );
  const amounts = z
    .strictObject({ allTimeUsd: z.number(), todayUsd: z.number() })
    .parse(other.rows[0]);
  const dimensions = {
    agent: [sql`c.agent_id`, sql`c.agent_id`],
    project: [sql`COALESCE(c.project_id,'workspace')`, sql`COALESCE(p.name,'Workspace')`],
    model: [
      sql`jsonb_build_array(c.provider_id,c.model_id)::text`,
      sql`c.provider_id || ' / ' || c.model_id`,
    ],
    day: [
      sql`to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD')`,
      sql`to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD')`,
    ],
  } as const;
  const groups: Record<string, z.infer<typeof costGroupSchema>[]> = {};
  for (const [name, [key, label]] of Object.entries(dimensions)) {
    const result = await db.orm.execute(
      sql`SELECT ${key} AS key, ${label} AS label, ${metrics} FROM cost_ledger c LEFT JOIN projects p ON p.id=c.project_id WHERE ${owner} AND c.created_at >= ${period.start} GROUP BY ${key},${label} ORDER BY "costUsd" DESC,key LIMIT 500`,
    );
    groups[name] = z.array(costGroupSchema).parse(secretRedactor.redact(result.rows));
  }
  const caps = settings.budgets.value;
  const thresholds = project
    ? project.budgetUsd === null
      ? []
      : [costThreshold('project', project.budgetUsd, amounts.allTimeUsd, caps.alertPercentages)]
    : [
        costThreshold('day', caps.dailyUsd, amounts.todayUsd, caps.alertPercentages),
        costThreshold('month', caps.monthlyUsd, summary.costUsd, caps.alertPercentages),
      ];
  return costDashboardSchema.parse({
    ...summary,
    ...amounts,
    asOf: now.toISOString(),
    monthStart: period.start.toISOString(),
    monthEnd: period.end.toISOString(),
    projectId: projectId ?? null,
    forecastUsd: (summary.costUsd / period.elapsedDays) * period.daysInMonth,
    elapsedDays: period.elapsedDays,
    daysInMonth: period.daysInMonth,
    thresholds,
    groups,
  });
}

/** Receipt and notification are committed together; competing pollers cannot duplicate an alert. */
export async function collectCostAlerts(
  db: Database,
  userId: string,
  settings: SettingsDocument,
  now = new Date(),
) {
  const period = utcCostPeriod(now);
  const totals = await db.orm.execute(
    sql`SELECT COALESCE(sum(c.cost_usd) FILTER (WHERE c.created_at >= ${period.day}),0)::float8 AS day, COALESCE(sum(c.cost_usd) FILTER (WHERE c.created_at >= ${period.start}),0)::float8 AS month FROM cost_ledger c LEFT JOIN projects p ON p.id=c.project_id WHERE ${ownedLedger(userId)} AND c.created_at <= ${now}`,
  );
  const spent = z.strictObject({ day: z.number(), month: z.number() }).parse(totals.rows[0]);
  const projectRows = await db.orm.execute(
    sql`SELECT p.id, p.budget_usd AS cap, p.created_at AS start, p.privacy, COALESCE(sum(c.cost_usd),0)::float8 AS spent FROM projects p LEFT JOIN cost_ledger c ON c.project_id=p.id AND c.created_at <= ${now} WHERE p.user_id=${userId} AND p.budget_usd IS NOT NULL GROUP BY p.id`,
  );
  const candidates = [
    {
      projectId: null,
      threshold: costThreshold(
        'day',
        settings.budgets.value.dailyUsd,
        spent.day,
        settings.budgets.value.alertPercentages,
      ),
      start: period.day,
      privateOnly: true,
    },
    {
      projectId: null,
      threshold: costThreshold(
        'month',
        settings.budgets.value.monthlyUsd,
        spent.month,
        settings.budgets.value.alertPercentages,
      ),
      start: period.start,
      privateOnly: true,
    },
    ...z
      .array(
        z.strictObject({
          id: z.string(),
          cap: z.number(),
          start: z.coerce.date(),
          privacy: z.string(),
          spent: z.number(),
        }),
      )
      .parse(projectRows.rows)
      .map((row) => ({
        projectId: row.id,
        threshold: costThreshold(
          'project',
          row.cap,
          row.spent,
          settings.budgets.value.alertPercentages,
        ),
        start: row.start,
        privateOnly: row.privacy === 'private',
      })),
  ];
  let created = 0;
  for (const candidate of candidates)
    for (const threshold of candidate.threshold.reached) {
      const { period: kind, capUsd, spentUsd } = candidate.threshold;
      const eventKey =
        'cost:' +
        valueHash({
          userId,
          projectId: candidate.projectId,
          kind,
          start: candidate.start.toISOString(),
          capUsd,
          threshold,
        });
      created += await db.orm.transaction(async (tx) => {
        const inserted = await tx
          .insert(costAlerts)
          .values({
            id: workKey('cst'),
            userId,
            projectId: candidate.projectId,
            eventKey,
            period: kind,
            periodStart: candidate.start,
            capUsd,
            threshold,
            spentUsd,
            createdAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: costAlerts.id });
        if (!inserted.length) return 0;
        await tx.insert(notifications).values({
          id: workKey('ntf'),
          userId,
          projectId: candidate.projectId,
          eventKey,
          title: `${kind === 'project' ? 'Project' : kind === 'day' ? 'Daily' : 'Monthly'} budget reached ${threshold}%`,
          body: `Recorded model spend is $${spentUsd.toFixed(4)} against a $${capUsd.toFixed(2)} cap. Review Costs and budget settings.`,
          level: threshold === 100 ? 'urgent' : 'normal',
          signals: { moneyInvolved: true },
          privateOnly: candidate.privateOnly,
          createdAt: now,
        });
        return 1;
      });
    }
  return created;
}
