import { randomUUID } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import type { SettingsDocument } from '@sazuz/config/settings';
import {
  agentRoleSchema,
  triggerConfigSchema,
  triggerSchema,
  recipePolicySchema,
  type TriggerInput,
} from '@sazuz/core/missions';
import {
  triggers,
  triggerEvents,
  projects,
  insertMission,
  workKey,
  jsonValue,
  MissionError,
  getControl,
  approvals,
  runs,
  toolCalls,
  enqueueRun,
  type Database,
} from '@sazuz/db';
import {
  initialImapCursor,
  imapCursorSchema,
  fetchRssFeed,
  rssTriggerCandidates,
  pollImapTrigger,
  pollBackoff,
  nextCronOccurrences,
  cronTriggerCandidate,
  type ImapListingRequest,
  type TriggerCandidate,
} from '@sazuz/triggers';
import { secretRedactor } from '@sazuz/vault';
import type { SafeNetworkDependencies } from '@sazuz/tools';
import { startWorkflowIn } from '@sazuz/workflows';

export const publicTrigger = (row: typeof triggers.$inferSelect) =>
  triggerSchema.parse({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    goal: row.goal,
    agent: row.agent,
    recipePolicy: row.recipePolicy,
    config: row.config,
    enabled: row.enabled,
    version: row.version,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    webhookPath:
      triggerConfigSchema.parse(row.config).kind === 'webhook' ? `/hooks/${row.id}` : null,
  });
/** Truncate the data before closing its trust boundary, including after escape expansion. */
export function triggerGoal(goal: string, payload: string | undefined, tainted: boolean): string {
  if (!payload) return goal.slice(0, 16000);
  const prefix = `${goal.slice(0, 9000)}\nTrigger input:\n`;
  const open = tainted ? '<untrusted>\n' : '';
  const close = tainted ? '\n</untrusted>' : '';
  const data = tainted ? payload.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e') : payload;
  return `${prefix}${open}${data.slice(0, 16000 - prefix.length - open.length - close.length)}${close}`;
}
export async function listTriggers(database: Database, userId: string) {
  return (
    await database.orm
      .select({ trigger: triggers })
      .from(triggers)
      .innerJoin(projects, eq(projects.id, triggers.projectId))
      .where(eq(projects.userId, userId))
  ).map(({ trigger }) => publicTrigger(trigger));
}
export async function insertTrigger(
  database: Database,
  userId: string,
  input: TriggerInput,
  now = new Date(),
) {
  const [project] = await database.orm
    .select()
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.userId, userId)));
  if (!project) throw new MissionError('MISSION_NOT_FOUND');
  const config = triggerConfigSchema.parse(input.config);
  const next =
    config.kind === 'cron'
      ? new Date(
          nextCronOccurrences({
            expression: config.expression,
            timezone: config.timezone,
            now,
            count: 1,
          })[0]!,
        )
      : config.kind === 'webhook'
        ? null
        : now;
  const [row] = await database.orm
    .insert(triggers)
    .values({
      id: workKey('trg'),
      projectId: input.projectId,
      name: secretRedactor.redactText(input.name),
      goal: secretRedactor.redactText(input.goal),
      agent: input.agent,
      config,
      enabled: input.enabled,
      nextRunAt: next,
    })
    .returning();
  return publicTrigger(row!);
}
export async function triggerMission(
  database: Database,
  userId: string,
  triggerId: string,
  getSettings: () => SettingsDocument,
  event?: { key: string; payload: string; tainted: boolean },
  now = new Date(),
) {
  return database.orm.transaction(async (tx) => {
    const [row] = await tx
      .select({ trigger: triggers, project: projects })
      .from(triggers)
      .innerJoin(projects, eq(projects.id, triggers.projectId))
      .where(and(eq(triggers.id, triggerId), eq(projects.userId, userId)))
      .for('update', { of: triggers });
    if (!row) throw new MissionError('MISSION_NOT_FOUND');
    if (event && !row.trigger.enabled) throw new MissionError('MISSION_INVALID');
    if (event) {
      const inserted = await tx
        .insert(triggerEvents)
        .values({ id: workKey('evt'), triggerId, dedupeKey: event.key })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length) return null;
    }
    const caps = getSettings().budgets.value;
    const id =
      row.trigger.workflowId && row.trigger.workflowRevision
        ? (
            await startWorkflowIn(
              tx,
              userId,
              row.trigger.workflowId,
              {
                requestId: randomUUID(),
                revision: row.trigger.workflowRevision,
                input: { event: event?.payload ?? null },
                test: false,
              },
              getSettings(),
              event?.tainted ?? false,
            )
          ).missionId
        : await insertMission(
            tx,
            userId,
            {
              projectId: row.project.id,
              title: row.trigger.name,
              goal: triggerGoal(row.trigger.goal, event?.payload, event?.tainted ?? false),
              agent: agentRoleSchema.parse(row.trigger.agent),
              requestId: randomUUID(),
            },
            {
              maxSteps: caps.maxSteps,
              maxCostUsd: caps.perRunUsd,
              maxWallTimeSeconds: caps.maxWallTimeSeconds,
            },
            'trigger',
            (event?.tainted ?? false) || row.trigger.recipePolicy !== null,
            undefined,
            recipePolicySchema.nullable().parse(row.trigger.recipePolicy),
          );
    if (event)
      await tx
        .update(triggerEvents)
        .set({ missionId: id })
        .where(and(eq(triggerEvents.triggerId, triggerId), eq(triggerEvents.dedupeKey, event.key)));
    await tx
      .update(triggers)
      .set({ lastRunAt: now, lastError: null })
      .where(eq(triggers.id, triggerId));
    return id;
  });
}
export interface AutomationOptions {
  database: Database;
  getSettings: () => SettingsDocument;
  signal: AbortSignal;
  listImap(request: ImapListingRequest, triggerId: string): Promise<unknown>;
  network?: SafeNetworkDependencies;
}
export function createAutomationRunner(options: AutomationOptions) {
  const { database, getSettings } = options;
  async function tick(now = new Date()) {
    if ((await getControl(database)).paused) return;
    const lease = await database.pool.connect();
    let owned = false;
    try {
      owned =
        (await lease.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(72839103) AS locked'))
          .rows[0]?.locked ?? false;
      if (!owned) return;
      const rows = await database.orm
        .select({ trigger: triggers, project: projects })
        .from(triggers)
        .innerJoin(projects, eq(projects.id, triggers.projectId))
        .where(and(eq(triggers.enabled, true), lte(triggers.nextRunAt, now)))
        .limit(20);
      for (const { trigger, project } of rows) {
        if (options.signal.aborted) return;
        const config = triggerConfigSchema.parse(trigger.config);
        try {
          let candidates: TriggerCandidate[] = [];
          let cursor: unknown = trigger.cursor;
          let next: Date | null = null;
          if (config.kind === 'cron') {
            candidates = [cronTriggerCandidate(trigger.id, trigger.nextRunAt!)];
            next = new Date(
              nextCronOccurrences({
                expression: config.expression,
                timezone: config.timezone,
                now,
                count: 1,
              })[0]!,
            );
          } else if (config.kind === 'rss') {
            const items = await fetchRssFeed(config.url, options.signal, options.network);
            candidates = rssTriggerCandidates({ triggerId: trigger.id, items, now });
            next = new Date(now.getTime() + config.pollIntervalSeconds * 1000);
          } else if (config.kind === 'imap') {
            const result = await pollImapTrigger(
              {
                triggerId: trigger.id,
                config,
                cursor: trigger.cursor ? imapCursorSchema.parse(trigger.cursor) : initialImapCursor,
                now,
                signal: options.signal,
                limit: 20,
              },
              { listMessages: (request) => options.listImap(request, trigger.id) },
            );
            candidates = result.candidates;
            cursor = result.nextCursor;
            next = new Date(result.nextPollAt);
          } else continue;
          await database.orm.transaction(async (tx) => {
            const [current] = await tx
              .select()
              .from(triggers)
              .where(eq(triggers.id, trigger.id))
              .for('update');
            if (!current?.enabled || current.version !== trigger.version) return;
            for (const candidate of candidates) {
              const inserted = await tx
                .insert(triggerEvents)
                .values({
                  id: workKey('evt'),
                  triggerId: trigger.id,
                  dedupeKey: candidate.dedupeKey,
                })
                .onConflictDoNothing()
                .returning();
              if (!inserted.length) continue;
              const limits = getSettings().budgets.value;
              const goal = triggerGoal(
                trigger.goal,
                JSON.stringify(candidate.payload),
                candidate.untrusted,
              );
              const missionId =
                current.workflowId && current.workflowRevision
                  ? (
                      await startWorkflowIn(
                        tx,
                        project.userId,
                        current.workflowId,
                        {
                          requestId: randomUUID(),
                          revision: current.workflowRevision,
                          input: { event: candidate.payload },
                          test: false,
                        },
                        getSettings(),
                        candidate.untrusted,
                      )
                    ).missionId
                  : await insertMission(
                      tx,
                      project.userId,
                      {
                        projectId: project.id,
                        title: trigger.name,
                        goal,
                        agent: agentRoleSchema.parse(trigger.agent),
                        requestId: randomUUID(),
                      },
                      {
                        maxSteps: limits.maxSteps,
                        maxCostUsd: limits.perRunUsd,
                        maxWallTimeSeconds: limits.maxWallTimeSeconds,
                      },
                      'trigger',
                      candidate.untrusted || trigger.recipePolicy !== null,
                      undefined,
                      recipePolicySchema.nullable().parse(trigger.recipePolicy),
                    );
              await tx
                .update(triggerEvents)
                .set({ missionId })
                .where(eq(triggerEvents.id, inserted[0]!.id));
            }
            await tx
              .update(triggers)
              .set({
                cursor: cursor === null ? null : jsonValue(cursor),
                nextRunAt: next,
                lastRunAt: now,
                lastError: null,
                failures: 0,
              })
              .where(eq(triggers.id, trigger.id));
          });
        } catch {
          const base =
            config.kind === 'rss' || config.kind === 'imap' ? config.pollIntervalSeconds : 60;
          const backoff = pollBackoff({
            baseIntervalSeconds: base,
            consecutiveFailures: trigger.failures + 1,
            now,
          });
          await database.orm
            .update(triggers)
            .set({
              failures: trigger.failures + 1,
              lastError: 'The source could not be read. Check its configuration, access and vault.',
              nextRunAt: new Date(backoff.nextPollAt),
            })
            .where(eq(triggers.id, trigger.id));
          database.logger.warn(
            { code: 'TRIGGER_POLL_FAILED', triggerId: trigger.id },
            'A trigger will retry after backoff.',
          );
        }
      }
    } finally {
      if (owned) await lease.query('SELECT pg_advisory_unlock(72839103)');
      lease.release();
    }
  }
  return { tick };
}
export async function expireApprovals(database: Database, now = new Date()) {
  await database.orm.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, now)))
      .for('update', { skipLocked: true });
    for (const row of rows) {
      await tx
        .update(approvals)
        .set({
          status: 'expired',
          decision: 'deny',
          note: 'The approval expired without authorization.',
          version: row.version + 1,
          updatedAt: now,
        })
        .where(eq(approvals.id, row.id));
      if (row.kind === 'uncertain')
        await tx
          .update(toolCalls)
          .set({
            status: 'done',
            result: jsonValue({
              output: {
                cancelled: true,
                outcome: 'unknown',
                reason: 'Uncertain action approval expired; no retry is authorized.',
              },
              untrusted: false,
            }),
            updatedAt: now,
          })
          .where(eq(toolCalls.idempotencyKey, row.callKey));
      const changed = await tx
        .update(runs)
        .set({ status: 'queued', reason: null, version: sql`${runs.version}+1`, updatedAt: now })
        .where(and(eq(runs.id, row.runId), eq(runs.status, 'waiting_approval')))
        .returning();
      if (changed.length) await enqueueRun(tx, row.runId);
    }
  });
}
