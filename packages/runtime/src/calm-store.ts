import { and, eq, sql } from 'drizzle-orm';
import { settingsSchemas } from '@sazuz/config/settings';
import {
  notificationEvidenceSchema,
  notificationFeedbackInputSchema,
  notificationFeedbackSchema,
} from '@sazuz/core/calm';
import {
  notificationInterruptions,
  notificationFeedback,
  notifications,
  deliveryIntents,
  settings,
  saveSettingIn,
  MissionError,
  type Database,
} from '@sazuz/db';
import { notificationSource } from './calm.js';

export async function interruptionCount(db: Database, userId: string, day: string) {
  const result = await db.pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM notification_interruptions WHERE user_id=$1 AND day=$2',
    [userId, day],
  );
  return result.rows[0]?.count ?? 0;
}
/** Reserve before dispatch; uncertain deliveries retain their slot. Reconciliation never resends. */
export async function reserveInterruption(
  db: Database,
  input: { deliveryId: string; userId: string; day: string; cap: number },
) {
  return db.orm.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId + ':' + input.day},9))`,
    );
    const slots = await tx
      .select()
      .from(notificationInterruptions)
      .where(
        and(
          eq(notificationInterruptions.userId, input.userId),
          eq(notificationInterruptions.day, input.day),
        ),
      );
    if (slots.some((slot) => slot.deliveryId === input.deliveryId)) return true;
    // A pre-existing intent can only be reconciled; deliverOnce cannot send it a second time.
    if (
      (await tx.select().from(deliveryIntents).where(eq(deliveryIntents.id, input.deliveryId)))
        .length
    )
      return true;
    if (slots.length >= input.cap) return false;
    await tx.insert(notificationInterruptions).values({
      deliveryId: input.deliveryId,
      userId: input.userId,
      day: input.day,
      slot: slots.length + 1,
    });
    return true;
  });
}

export async function saveNotificationFeedback(
  db: Database,
  userId: string,
  notificationId: string,
  raw: unknown,
) {
  const input = notificationFeedbackInputSchema.parse(raw);
  return db.orm.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId + ':' + input.requestId},10))`,
    );
    const [prior] = await tx
      .select()
      .from(notificationFeedback)
      .where(
        and(
          eq(notificationFeedback.userId, userId),
          eq(notificationFeedback.requestId, input.requestId),
        ),
      );
    if (prior) {
      if (prior.notificationId !== notificationId || prior.kind !== input.kind)
        throw new MissionError('MISSION_CONFLICT');
      return notificationFeedbackSchema.parse({
        notificationId: prior.notificationId,
        kind: prior.kind,
        bias: prior.bias,
        settingsVersion: prior.settingsVersion,
      });
    }
    const [notification] = await tx
      .select()
      .from(notifications)
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
      .for('update');
    if (!notification) throw new MissionError('MISSION_NOT_FOUND');
    const evidence = notificationEvidenceSchema.safeParse(notification.priorityEvidence);
    const source = evidence.success
      ? evidence.data.source
      : (await notificationSource(db, notification)).source;
    const [current] = await tx
      .select()
      .from(settings)
      .where(eq(settings.namespace, 'profile'))
      .for('update');
    if (!current) throw new MissionError('MISSION_INVALID');
    const profile = settingsSchemas.profile.parse(current.value);
    const rule = profile.priorityRules.find(
      (item) => item.projectId === notification.projectId && item.source === source,
    );
    const weight = (value: string | null) =>
      value === 'sooner' ? 20 : value === 'not_important' ? -20 : 0;
    const bias = Math.max(
      -40,
      Math.min(40, (rule?.bias ?? 0) + weight(input.kind) - weight(notification.feedback)),
    );
    let version = current.version;
    if (input.kind !== notification.feedback) {
      if (rule) rule.bias = bias;
      else profile.priorityRules.push({ projectId: notification.projectId, source, bias });
      version = (
        await saveSettingIn(tx, {
          namespace: 'profile',
          value: profile,
          expectedVersion: current.version,
          actorId: userId,
        })
      ).version;
      await tx
        .update(notifications)
        .set({ feedback: input.kind })
        .where(eq(notifications.id, notificationId));
    }
    await tx.insert(notificationFeedback).values({
      userId,
      requestId: input.requestId,
      notificationId,
      kind: input.kind,
      bias,
      settingsVersion: version,
    });
    return notificationFeedbackSchema.parse({
      notificationId,
      kind: input.kind,
      bias,
      settingsVersion: version,
    });
  });
}
