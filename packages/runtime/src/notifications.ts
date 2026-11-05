import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SettingsDocument } from '@sazuz/config/settings';
import {
  approvals,
  deliveryIntents,
  digests,
  missions,
  notifications,
  projects,
  runs,
  runSteps,
  telegramBindings,
  auditLog,
  jsonValue,
  workKey,
  type Database,
} from '@sazuz/db';
import {
  routeNotification,
  notificationDayKey,
  renderDigest,
  isQuietTime,
  nextQuietEnd,
} from '@sazuz/triggers';
import {
  telegramApprovalButtons,
  type TelegramPairing,
  type TelegramReplyMarkup,
  TelegramError,
} from '@sazuz/channels';
import { secretRedactor } from '@sazuz/vault';
import { prioritizeNotification, type NotificationClassifier } from './calm.js';
import { interruptionCount, reserveInterruption } from './calm-store.js';

export type Delivery = (
  recipient: TelegramPairing,
  text: string,
  replyMarkup?: TelegramReplyMarkup,
) => Promise<unknown>;
/** A crash after dispatch is uncertain. Telegram provides no safe sent-message lookup by key. */
export async function deliverOnce(
  database: Database,
  id: string,
  channel: string,
  target: string,
  send: () => Promise<unknown>,
): Promise<'delivered' | 'uncertain' | 'failed'> {
  const inserted = await database.orm
    .insert(deliveryIntents)
    .values({ id, status: 'intent', channel, target })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) {
    const [existing] = await database.orm
      .select()
      .from(deliveryIntents)
      .where(eq(deliveryIntents.id, id));
    if (existing?.status === 'done') return 'delivered';
    if (existing?.status === 'failed') return 'failed';
    await database.orm
      .update(deliveryIntents)
      .set({ status: 'uncertain', updatedAt: new Date() })
      .where(eq(deliveryIntents.id, id));
    return 'uncertain';
  }
  await database.orm.insert(auditLog).values({
    id: workKey('aud'),
    actorId: 'notification-router',
    action: 'policy.allow',
    target: `paired-notification:${id}`,
  });
  try {
    const result = await send();
    await database.orm
      .update(deliveryIntents)
      .set({ status: 'done', result: jsonValue(result ?? null), updatedAt: new Date() })
      .where(eq(deliveryIntents.id, id));
    return 'delivered';
  } catch (error) {
    const status =
      error instanceof TelegramError && error.delivery === 'not_sent' ? 'failed' : 'uncertain';
    await database.orm
      .update(deliveryIntents)
      .set({ status, updatedAt: new Date() })
      .where(eq(deliveryIntents.id, id));
    return status;
  }
}
export async function collectNotifications(database: Database, now = new Date()) {
  const completed = await database.orm
    .select({ run: runs, mission: missions, project: projects })
    .from(runs)
    .innerJoin(missions, eq(missions.id, runs.missionId))
    .innerJoin(projects, eq(projects.id, missions.projectId))
    .where(
      and(
        sql`${runs.parentRunId} IS NULL`,
        sql`${missions.source} <> 'run-replay'`,
        sql`${runs.status} IN ('completed','budget_exceeded','failed','paused')`,
        sql`NOT EXISTS (SELECT 1 FROM ${notifications} WHERE ${notifications.eventKey} = 'run:' || ${runs.id} || ':' || ${runs.status})`,
      ),
    )
    .orderBy(desc(runs.updatedAt))
    .limit(100);
  for (const { run, mission, project } of completed) {
    const [last] = await database.orm
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, run.id), eq(runSteps.kind, 'assistant')))
      .orderBy(desc(runSteps.ordinal))
      .limit(1);
    const body = secretRedactor
      .redactText(
        (run.status === 'completed' ? last?.content : run.reason) ??
          'Open the mission for details.',
      )
      .slice(0, 16000);
    await database.orm
      .insert(notifications)
      .values({
        id: workKey('ntf'),
        userId: project.userId,
        projectId: project.id,
        missionId: mission.id,
        eventKey: `run:${run.id}:${run.status}`,
        sourceRunId: run.id,
        level: run.status === 'completed' ? 'normal' : 'urgent',
        title: `${mission.title}: ${run.status.replaceAll('_', ' ')}`,
        body,
        createdAt: now,
      })
      .onConflictDoNothing();
  }
  const waiting = await database.orm
    .select({ approval: approvals, mission: missions, project: projects })
    .from(approvals)
    .innerJoin(runs, eq(runs.id, approvals.runId))
    .innerJoin(missions, eq(missions.id, runs.missionId))
    .innerJoin(projects, eq(projects.id, missions.projectId))
    .where(
      and(
        eq(approvals.status, 'pending'),
        sql`${missions.source} <> 'run-replay'`,
        sql`NOT EXISTS (SELECT 1 FROM ${notifications} WHERE ${notifications.eventKey} = 'approval:' || ${approvals.id} || ':' || ${approvals.version})`,
      ),
    )
    .limit(100);
  for (const { approval, mission, project } of waiting) {
    const body = secretRedactor.redactText(
      `${approval.toolName}\n${approval.reason}\n${JSON.stringify(approval.args).slice(0, 2000)}${approval.tainted ? '\nProposed after reading untrusted content.' : ''}`,
    );
    await database.orm
      .insert(notifications)
      .values({
        id: workKey('ntf'),
        userId: project.userId,
        projectId: project.id,
        missionId: mission.id,
        eventKey: `approval:${approval.id}:${approval.version}`,
        sourceRunId: approval.runId,
        level: 'urgent',
        title: `Approval needed: ${mission.title}`,
        body,
        createdAt: now,
      })
      .onConflictDoNothing();
  }
}
export function createNotificationRouter(options: {
  database: Database;
  getSettings: () => SettingsDocument;
  deliver: Delivery;
  classifier?: NotificationClassifier;
}) {
  const { database, getSettings } = options;
  async function tick(now = new Date()) {
    const lease = await database.pool.connect();
    let owned = false;
    try {
      owned =
        (await lease.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(72839104) AS locked'))
          .rows[0]?.locked ?? false;
      if (!owned) return;
      await collectNotifications(database, now);
      const settings = getSettings();
      const rows = await database.orm
        .select()
        .from(notifications)
        .where(
          and(
            sql`${notifications.status} IN ('pending','deferred')`,
            sql`(${notifications.dueAt} IS NULL OR ${notifications.dueAt} <= ${now})`,
          ),
        )
        .orderBy(notifications.createdAt)
        .limit(200);
      let classificationBudget = 8;
      for (const candidate of rows) {
        const [receipt] = await database.orm
          .select()
          .from(deliveryIntents)
          .where(eq(deliveryIntents.id, `notification:${candidate.id}`));
        if (receipt) {
          const result = await deliverOnce(
            database,
            receipt.id,
            receipt.channel,
            receipt.target,
            () =>
              Promise.reject(new Error('An existing notification intent cannot be sent again.')),
          );
          await database.orm
            .update(notifications)
            .set({
              status:
                result === 'delivered'
                  ? 'delivered'
                  : result === 'uncertain'
                    ? 'uncertain'
                    : 'logged',
              dueAt: receipt.createdAt,
            })
            .where(eq(notifications.id, candidate.id));
          continue;
        }
        const row = await prioritizeNotification(
          database,
          candidate,
          settings,
          now,
          classificationBudget-- > 0 ? options.classifier : undefined,
        );
        if (row.dueAt && row.dueAt > now) continue;
        if (row.eventKey.startsWith('approval:')) {
          const [, id, version] = row.eventKey.split(':');
          const [pendingApproval] = await database.orm
            .select()
            .from(approvals)
            .where(
              and(
                eq(approvals.id, id!),
                eq(approvals.status, 'pending'),
                eq(approvals.version, Number(version)),
              ),
            );
          if (!pendingApproval) {
            await database.orm
              .update(notifications)
              .set({ status: 'logged' })
              .where(eq(notifications.id, row.id));
            continue;
          }
        }
        const day = notificationDayKey({ timezone: settings.general.value.timezone, now });
        const interruptionsToday = await interruptionCount(database, row.userId, day);
        const decision = routeNotification({
          priority: z.enum(['urgent', 'normal', 'low']).parse(row.level),
          critical: row.critical,
          profile: settings.profile.value,
          timezone: settings.general.value.timezone,
          channels: settings.channels.value,
          interruptionsToday,
          now,
        });
        if (decision.route === 'logged') {
          await database.orm
            .update(notifications)
            .set({ status: 'logged' })
            .where(eq(notifications.id, row.id));
          continue;
        }
        if (decision.route === 'digest') {
          if (row.status !== 'deferred' || !row.dueAt)
            await database.orm
              .update(notifications)
              .set({ status: 'deferred', dueAt: new Date(decision.deliverAt!) })
              .where(eq(notifications.id, row.id));
          else if (
            isQuietTime({
              quietStart: settings.profile.value.quietStart,
              quietEnd: settings.profile.value.quietEnd,
              timezone: settings.general.value.timezone,
              now,
            })
          )
            await database.orm
              .update(notifications)
              .set({
                status: 'deferred',
                dueAt: new Date(
                  nextQuietEnd({
                    quietStart: settings.profile.value.quietStart,
                    quietEnd: settings.profile.value.quietEnd,
                    timezone: settings.general.value.timezone,
                    now,
                  })!,
                ),
              })
              .where(eq(notifications.id, row.id));
          continue;
        }
        if (new Date(decision.deliverAt!) > now) {
          await database.orm
            .update(notifications)
            .set({ status: 'pending', dueAt: new Date(decision.deliverAt!) })
            .where(eq(notifications.id, row.id));
          continue;
        }
        let status: 'delivered' | 'uncertain' | 'logged' = 'logged';
        if (decision.channel === 'telegram' && row.projectId) {
          const [binding] = await database.orm
            .select()
            .from(telegramBindings)
            .where(
              and(
                eq(telegramBindings.userId, row.userId),
                eq(telegramBindings.projectId, row.projectId),
              ),
            )
            .limit(1);
          if (binding) {
            let buttons: TelegramReplyMarkup | undefined;
            if (row.eventKey.startsWith('approval:')) {
              const [, id, version] = row.eventKey.split(':');
              const [approval] = await database.orm
                .select()
                .from(approvals)
                .where(
                  and(
                    eq(approvals.id, id!),
                    eq(approvals.status, 'pending'),
                    eq(approvals.version, Number(version)),
                  ),
                );
              if (!approval) {
                await database.orm
                  .update(notifications)
                  .set({ status: 'logged' })
                  .where(eq(notifications.id, row.id));
                continue;
              }
              if (approval.kind === 'policy')
                buttons = telegramApprovalButtons({
                  approvalId: id!,
                  version: approval.version,
                  viewUrl: `${settings.general.value.baseUrl}/approvals`,
                });
            }
            const recipient = {
              userId: binding.userId,
              projectId: binding.projectId,
              senderId: binding.senderId,
              chatId: binding.chatId,
            };
            if (
              !(await reserveInterruption(database, {
                deliveryId: `notification:${row.id}`,
                userId: row.userId,
                day,
                cap: settings.profile.value.noiseBudget,
              }))
            ) {
              await database.orm
                .update(notifications)
                .set({ status: 'deferred', dueAt: now })
                .where(eq(notifications.id, row.id));
              continue;
            }
            const result = await deliverOnce(
              database,
              `notification:${row.id}`,
              'telegram',
              binding.id,
              () =>
                options.deliver(recipient, `${row.title}\n\n${row.body}`.slice(0, 3900), buttons),
            );
            status =
              result === 'delivered'
                ? 'delivered'
                : result === 'uncertain'
                  ? 'uncertain'
                  : 'logged';
          }
        }
        await database.orm
          .update(notifications)
          .set({ status, dueAt: now })
          .where(eq(notifications.id, row.id));
      }
      const due = await database.orm
        .select()
        .from(notifications)
        .where(and(eq(notifications.status, 'deferred'), lte(notifications.dueAt, now)))
        .limit(200);
      for (const group of new Set(due.map((row) => JSON.stringify([row.userId, row.projectId])))) {
        // Quiet/noise routing has already moved urgent pushes; remaining due items form the digest.
        const candidates = due.filter(
          (row) => JSON.stringify([row.userId, row.projectId]) === group,
        );
        const { userId, projectId } = candidates[0]!;
        const [existing] = await database.orm
          .select()
          .from(digests)
          .where(
            and(
              eq(digests.userId, userId),
              projectId ? eq(digests.projectId, projectId) : sql`${digests.projectId} IS NULL`,
              eq(digests.deliveryStatus, 'pending'),
              sql`NOT EXISTS (SELECT 1 FROM ${deliveryIntents} WHERE ${deliveryIntents.id} = 'digest:' || ${digests.id})`,
            ),
          )
          .orderBy(digests.createdAt)
          .limit(1);
        const oldIds = z.array(z.string()).parse(existing?.notificationIds ?? []);
        const old = oldIds.length
          ? await database.orm.select().from(notifications).where(inArray(notifications.id, oldIds))
          : [];
        const rendered = renderDigest(
          [...old, ...candidates].map((row) => ({
            id: row.id,
            groupKey: row.projectId ?? 'global',
            title: row.title,
            body: row.body,
            priority: z.enum(['urgent', 'normal', 'low']).parse(row.level),
            createdAt: row.createdAt.toISOString(),
          })),
        );
        if (!rendered.notificationIds.length) continue;
        const digestId = existing?.id ?? workKey('dig');
        await database.orm.transaction(async (tx) => {
          const values = {
            id: digestId,
            userId,
            projectId,
            title: rendered.title,
            body: rendered.body,
            itemCount: rendered.notificationIds.length,
            notificationIds: rendered.notificationIds,
            deliveryStatus:
              projectId && settings.channels.value.digest === 'telegram' ? 'pending' : 'web',
            createdAt: now,
          };
          if (existing) await tx.update(digests).set(values).where(eq(digests.id, digestId));
          else await tx.insert(digests).values(values);
          for (const id of rendered.notificationIds)
            await tx
              .update(notifications)
              .set({ status: 'digested' })
              .where(and(eq(notifications.id, id), eq(notifications.status, 'deferred')));
          const displaced = oldIds.filter((id) => !rendered.notificationIds.includes(id));
          if (displaced.length)
            await tx
              .update(notifications)
              .set({ status: 'deferred', dueAt: now })
              .where(inArray(notifications.id, displaced));
        });
      }
      const pending = await database.orm
        .select()
        .from(digests)
        .where(eq(digests.deliveryStatus, 'pending'))
        .limit(30);
      for (const digest of pending) {
        if (
          isQuietTime({
            quietStart: settings.profile.value.quietStart,
            quietEnd: settings.profile.value.quietEnd,
            timezone: settings.general.value.timezone,
            now,
          })
        )
          continue;
        const [binding] = digest.projectId
          ? await database.orm
              .select()
              .from(telegramBindings)
              .where(
                and(
                  eq(telegramBindings.userId, digest.userId),
                  eq(telegramBindings.projectId, digest.projectId),
                ),
              )
              .limit(1)
          : [];
        if (!binding) {
          await database.orm
            .update(digests)
            .set({ deliveryStatus: 'web' })
            .where(eq(digests.id, digest.id));
          continue;
        }
        const recipient = {
          userId: binding.userId,
          projectId: binding.projectId,
          senderId: binding.senderId,
          chatId: binding.chatId,
        };
        if (
          !(await reserveInterruption(database, {
            deliveryId: `digest:${digest.id}`,
            userId: digest.userId,
            day: notificationDayKey({ timezone: settings.general.value.timezone, now }),
            cap: settings.profile.value.noiseBudget,
          }))
        )
          continue;
        const result = await deliverOnce(
          database,
          `digest:${digest.id}`,
          'telegram',
          binding.id,
          () => options.deliver(recipient, `${digest.title}\n\n${digest.body}`.slice(0, 3900)),
        );
        await database.orm
          .update(digests)
          .set({
            deliveryStatus:
              result === 'delivered' ? 'delivered' : result === 'uncertain' ? 'uncertain' : 'web',
          })
          .where(eq(digests.id, digest.id));
      }
    } finally {
      let reusable = false;
      try {
        if (owned) await lease.query('SELECT pg_advisory_unlock(72839104)');
        reusable = true;
      } finally {
        lease.release(!reusable);
      }
    }
  }
  return { tick };
}
