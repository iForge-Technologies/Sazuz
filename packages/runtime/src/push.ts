import { createHash } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { pushDeviceSchema, pushEnrollSchema, pushStatusSchema, PushError } from '@sazuz/core/push';
import { PushDeliveryError, validatePushSubscription, type PushSender } from '@sazuz/channels';
import {
  auditLog,
  digests,
  getControl,
  notifications,
  pushDeliveries,
  pushDevices,
  readSettings,
  settings as settingsTable,
  workKey,
  type Database,
} from '@sazuz/db';
import { evaluatePolicy } from '@sazuz/policy';
import { isQuietTime, notificationDayKey, routeNotification } from '@sazuz/triggers';
import { secretRedactor, type SecretReference, type Vault } from '@sazuz/vault';
import { interruptionCount, reserveInterruption } from './calm-store.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const publicDevice = (row: typeof pushDevices.$inferSelect) =>
  pushDeviceSchema.parse({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  });
type Event = {
  key: string;
  kind: 'activity' | 'digest';
  userId: string;
  projectId: string | null;
  createdAt: Date;
  critical: boolean;
};

/** Per-device receipts fan out a single Calm Mode interruption. They never carry private task content. */
export function createPushService(options: {
  database: Database;
  vault: Vault;
  publicKey: string;
  send: PushSender;
}) {
  const db = options.database;
  async function status(userId: string) {
    const document = await readSettings(db);
    const devices = await db.orm
      .select()
      .from(pushDevices)
      .where(eq(pushDevices.userId, userId))
      .orderBy(sql`${pushDevices.revokedAt} IS NULL DESC`, desc(pushDevices.createdAt))
      .limit(20);
    const deliveries = await db.orm
      .select({ row: pushDeliveries })
      .from(pushDeliveries)
      .innerJoin(pushDevices, eq(pushDevices.id, pushDeliveries.deviceId))
      .where(eq(pushDevices.userId, userId))
      .orderBy(desc(pushDeliveries.createdAt))
      .limit(30);
    return pushStatusSchema.parse({
      enabled: document.channels.value.webPush,
      publicKey: options.publicKey,
      devices: devices.map(publicDevice),
      deliveries: deliveries.map(({ row }) => ({
        id: row.id,
        deviceId: row.deviceId,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      })),
    });
  }
  async function enroll(userId: string, raw: unknown) {
    const parsed = pushEnrollSchema.safeParse(raw);
    if (!parsed.success) throw new PushError('PUSH_INVALID');
    const input = parsed.data;
    const subscription = validatePushSubscription(input.subscription);
    const document = await readSettings(db);
    if (!document.channels.value.webPush) throw new PushError('PUSH_DISABLED');
    const decision = evaluatePolicy({
      tool: 'push.enroll',
      effect: 'write',
      scope: 'internal',
      agentId: 'notifications',
      projectId: 'workspace',
      tainted: false,
      preset: document.security.value.preset,
      rules: document.security.value.rules,
      args: {},
      paused: (await getControl(db)).paused,
    });
    if (decision.action === 'deny') throw new PushError('PUSH_DENIED');
    return db.orm.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId},11))`);
      const endpointHash = hash(subscription.endpoint);
      const [prior] = await tx
        .select()
        .from(pushDevices)
        .where(eq(pushDevices.endpointHash, endpointHash));
      if (prior && prior.userId !== userId) throw new PushError('PUSH_INVALID');
      if (prior && !prior.revokedAt) return publicDevice(prior);
      const active = await tx
        .select()
        .from(pushDevices)
        .where(and(eq(pushDevices.userId, userId), isNull(pushDevices.revokedAt)));
      if (active.length >= 20) throw new PushError('PUSH_LIMIT');
      const secret = await options.vault.create(
        {
          name: 'Browser push subscription',
          value: JSON.stringify(subscription),
          createdBy: userId,
        },
        'web-push',
      );
      const values = {
        userId,
        name: secretRedactor.redactText(input.name),
        endpointHash,
        secretRef: secret.reference,
        createdAt: new Date(),
        revokedAt: null,
      };
      const [row] = prior
        ? await tx.update(pushDevices).set(values).where(eq(pushDevices.id, prior.id)).returning()
        : await tx
            .insert(pushDevices)
            .values({ id: workKey('psh'), ...values })
            .returning();
      if (!row) throw new PushError('PUSH_INVALID');
      await tx
        .insert(auditLog)
        .values({ id: workKey('aud'), actorId: userId, action: 'push.enrolled', target: row.id });
      return publicDevice(row);
    });
  }
  async function revoke(userId: string, id: string) {
    const [row] = await db.orm
      .update(pushDevices)
      .set({ revokedAt: new Date() })
      .where(and(eq(pushDevices.id, id), eq(pushDevices.userId, userId)))
      .returning();
    if (!row) throw new PushError('PUSH_NOT_FOUND');
    // Revocation is always available, including when execution is paused or the vault is locked.
    await db.orm
      .insert(auditLog)
      .values({ id: workKey('aud'), actorId: userId, action: 'push.revoked', target: id });
    return publicDevice(row);
  }
  async function dispatch(deviceId: string, event: Event, now: Date) {
    const [intent] = await db.orm
      .insert(pushDeliveries)
      .values({ id: workKey('pdl'), deviceId, eventKey: event.key, createdAt: now })
      .onConflictDoNothing()
      .returning();
    if (!intent) {
      await db.orm
        .update(pushDeliveries)
        .set({ status: 'uncertain', finishedAt: new Date() })
        .where(
          and(
            eq(pushDeliveries.deviceId, deviceId),
            eq(pushDeliveries.eventKey, event.key),
            eq(pushDeliveries.status, 'intent'),
          ),
        );
      return;
    }
    // Intent is already committed. Hold current consent/device locks through dispatch; a completed revoke waits for an admitted send.
    await db.orm.transaction(async (tx) => {
      const [device] = await tx
        .select()
        .from(pushDevices)
        .where(eq(pushDevices.id, deviceId))
        .for('update');
      const lockedSettings = await tx
        .select()
        .from(settingsTable)
        .where(inArray(settingsTable.namespace, ['channels', 'profile', 'general', 'security']))
        .for('share');
      const document = await readSettings(db);
      const channelTime =
        lockedSettings.find((row) => row.namespace === 'channels')?.updatedAt ?? now;
      let allowed =
        !!device &&
        !device.revokedAt &&
        device.userId === event.userId &&
        document.channels.value.webPush &&
        event.createdAt > device.createdAt &&
        event.createdAt > channelTime &&
        !(await getControl(db)).paused &&
        !(await options.vault.status()).locked;
      const day = notificationDayKey({ timezone: document.general.value.timezone, now });
      const count = await interruptionCount(db, event.userId, day);
      const reserved = await db.pool.query(
        'SELECT 1 FROM notification_interruptions WHERE delivery_id=$1 AND day=$2',
        [event.key, day],
      );
      const recent = await db.pool.query<{ count: number }>(
        'SELECT count(DISTINCT d.event_key)::int AS count FROM push_deliveries d JOIN push_devices p ON p.id=d.device_id WHERE p.user_id=$1 AND d.created_at >= $2',
        [event.userId, new Date(now.getTime() - 3600000)],
      );
      if (event.kind === 'digest')
        allowed &&=
          document.channels.value.digest === 'web' &&
          !isQuietTime({
            quietStart: document.profile.value.quietStart,
            quietEnd: document.profile.value.quietEnd,
            timezone: document.general.value.timezone,
            now,
          });
      else {
        const route = routeNotification({
          priority: 'urgent',
          critical: event.critical,
          profile: document.profile.value,
          channels: document.channels.value,
          timezone: document.general.value.timezone,
          interruptionsToday: Math.max(0, count - (reserved.rowCount ? 1 : 0)),
          now,
        });
        allowed &&=
          route.route === 'push' &&
          route.channel === 'web' &&
          !!route.deliverAt &&
          new Date(route.deliverAt) <= now;
      }
      const decision = evaluatePolicy({
        tool: 'push.notify',
        effect: 'send',
        scope: 'external',
        agentId: 'notifications',
        projectId: event.projectId ?? 'workspace',
        tainted: false,
        knownRecipient: true,
        preset: document.security.value.preset,
        rules: document.security.value.rules,
        args: { deviceId, kind: event.kind },
        now,
        paused: !allowed,
        usage: Object.fromEntries(
          document.security.value.rules.map((rule) => [
            rule.id,
            { hour: Math.max(0, (recent.rows[0]?.count ?? 1) - 1), run: 0 },
          ]),
        ),
      });
      // Explicit per-device and global consent is a standing grant for generic preset asks only. Custom asks/limits still stop unattended delivery.
      allowed &&=
        decision.action === 'allow' ||
        (decision.action === 'ask' && decision.ruleId.startsWith('preset:'));
      if (allowed)
        allowed = await reserveInterruption(db, {
          deliveryId: event.key,
          userId: event.userId,
          day,
          cap: document.profile.value.noiseBudget,
        });
      await tx.insert(auditLog).values({
        id: workKey('aud'),
        actorId: event.userId,
        action: `policy.${decision.action}`,
        target: intent.id,
      });
      let state: 'done' | 'uncertain' | 'skipped' = 'skipped';
      if (allowed && device) {
        try {
          await options.vault.withSecret(
            device.secretRef as SecretReference,
            'web-push',
            async (value) => {
              const subscription = validatePushSubscription(JSON.parse(value) as unknown);
              if (hash(subscription.endpoint) !== device.endpointHash)
                throw new PushError('PUSH_INVALID');
              await options.send(subscription, event.kind, event.key);
            },
          );
          state = 'done';
        } catch (error) {
          state = 'uncertain';
          if (error instanceof PushDeliveryError && error.expired) {
            state = 'skipped';
            await tx
              .update(pushDevices)
              .set({ revokedAt: new Date() })
              .where(eq(pushDevices.id, device.id));
          }
        }
      }
      await tx
        .update(pushDeliveries)
        .set({ status: state, finishedAt: new Date() })
        .where(eq(pushDeliveries.id, intent.id));
    });
  }
  async function tick(now = new Date()) {
    const lease = await db.pool.connect();
    let locked = false;
    const started = Date.now();
    try {
      locked =
        (await lease.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(72839115) AS locked'))
          .rows[0]?.locked ?? false;
      if (!locked) return;
      const document = await readSettings(db);
      if (
        !document.channels.value.webPush ||
        (await getControl(db)).paused ||
        (await options.vault.status()).locked
      )
        return;
      const devices = await db.orm
        .select()
        .from(pushDevices)
        .where(isNull(pushDevices.revokedAt))
        .orderBy(pushDevices.createdAt)
        .limit(20);
      if (!devices.length) return;
      const [channel] = await db.orm
        .select()
        .from(settingsTable)
        .where(eq(settingsTable.namespace, 'channels'));
      const since = new Date(
        Math.max(channel?.updatedAt.getTime() ?? now.getTime(), now.getTime() - 86400000),
      );
      const events: Event[] = [];
      const urgent = await db.orm
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.status, 'logged'),
            eq(notifications.level, 'urgent'),
            gte(notifications.createdAt, since),
            lte(notifications.dueAt, now),
          ),
        )
        .orderBy(desc(notifications.createdAt))
        .limit(30);
      for (const row of urgent) {
        if (row.eventKey.startsWith('approval:')) {
          const [, id, version] = row.eventKey.split(':');
          const pending = await db.pool.query(
            'SELECT 1 FROM approvals WHERE id=$1 AND version=$2 AND status=$3',
            [id, Number(version), 'pending'],
          );
          if (!pending.rowCount) continue;
        }
        events.push({
          key: `notification:${row.id}`,
          kind: 'activity',
          userId: row.userId,
          projectId: row.projectId,
          createdAt: row.createdAt,
          critical: row.critical,
        });
      }
      const summaries = await db.orm
        .select()
        .from(digests)
        .where(and(eq(digests.deliveryStatus, 'web'), gte(digests.createdAt, since)))
        .orderBy(desc(digests.createdAt))
        .limit(30);
      for (const row of summaries) {
        const ids = z.array(z.string()).max(1000).parse(row.notificationIds);
        const [oldest] = ids.length
          ? await db.orm
              .select()
              .from(notifications)
              .where(inArray(notifications.id, ids))
              .orderBy(notifications.createdAt)
              .limit(1)
          : [];
        if (oldest)
          events.push({
            key: `digest:${row.id}`,
            kind: 'digest',
            userId: row.userId,
            projectId: row.projectId,
            createdAt: oldest.createdAt,
            critical: false,
          });
      }
      for (const event of events) {
        if (Date.now() - started > 45000) return;
        const applicable = devices.filter(
          (device) =>
            device.userId === event.userId &&
            device.createdAt < event.createdAt &&
            event.createdAt > since,
        );
        if (!applicable.length) continue;
        const day = notificationDayKey({ timezone: document.general.value.timezone, now });
        if (event.kind === 'digest') {
          if (
            document.channels.value.digest !== 'web' ||
            isQuietTime({
              quietStart: document.profile.value.quietStart,
              quietEnd: document.profile.value.quietEnd,
              timezone: document.general.value.timezone,
              now,
            })
          )
            continue;
        } else {
          const existing = await db.pool.query(
            'SELECT 1 FROM notification_interruptions WHERE delivery_id=$1 AND day=$2',
            [event.key, day],
          );
          const route = routeNotification({
            priority: 'urgent',
            critical: event.critical,
            profile: document.profile.value,
            channels: document.channels.value,
            timezone: document.general.value.timezone,
            interruptionsToday: Math.max(
              0,
              (await interruptionCount(db, event.userId, day)) - (existing.rowCount ? 1 : 0),
            ),
            now,
          });
          if (
            route.route !== 'push' ||
            route.channel !== 'web' ||
            !route.deliverAt ||
            new Date(route.deliverAt) > now
          )
            continue;
        }
        for (const device of applicable) {
          if (Date.now() - started > 45000) return;
          await dispatch(device.id, event, new Date(now.getTime() + Date.now() - started));
        }
      }
    } finally {
      let reusable = false;
      try {
        if (locked) await lease.query('SELECT pg_advisory_unlock(72839115)');
        reusable = true;
      } finally {
        lease.release(!reusable);
      }
    }
  }
  return { status, enroll, revoke, tick };
}
