import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshSettings, type SettingsNamespace, type SettingsValues } from '@sazuz/config/settings';
import {
  digests,
  executionControl,
  notifications,
  notificationInterruptions,
  pushDevices,
  pushDeliveries,
  readSettings,
  saveSetting,
  securityRateLimits,
  secrets,
  settings as settingsTable,
  workKey,
} from '@sazuz/db';
import { pushStatusSchema } from '@sazuz/core/push';
import { PushDeliveryError, type PushSender } from '../../packages/channels/src/push.js';
import { registerPush } from '../../apps/server/src/phase-eleven-push.js';
import { phaseFourFixture } from './phase-four-fixture.js';

describe('Phase 11 vault-backed browser push and Calm Mode fanout', () => {
  let f: Awaited<ReturnType<typeof phaseFourFixture>>, push: ReturnType<typeof registerPush>;
  const send = vi.fn<PushSender>();
  const now = new Date('2032-06-10T09:00:00Z');
  async function setting<N extends SettingsNamespace>(namespace: N, value: SettingsValues[N]) {
    const current = await readSettings(f.db);
    await saveSetting(f.db, {
      namespace,
      value,
      expectedVersion: current[namespace].version,
      actorId: f.userId,
    });
  }
  beforeAll(async () => {
    f = await phaseFourFixture(
      (app, runtime) => {
        push = registerPush(app, runtime, { send, background: false });
      },
      { maxConnections: 24 },
    );
  });
  beforeEach(async () => {
    send.mockReset().mockResolvedValue();
    await f.db.orm.delete(pushDevices);
    await f.db.orm.delete(notifications);
    await f.db.orm.delete(digests);
    await f.db.orm.delete(notificationInterruptions);
    await f.db.orm.delete(securityRateLimits);
    await f.db.orm
      .insert(executionControl)
      .values({ paused: false })
      .onConflictDoUpdate({ target: executionControl.id, set: { paused: false } });
    const defaults = freshSettings();
    await setting('channels', { ...defaults.channels.value, webPush: true });
    await setting('profile', {
      ...defaults.profile.value,
      quietStart: '00:00',
      quietEnd: '00:00',
      noiseBudget: 3,
    });
    await setting('security', defaults.security.value);
  });
  afterAll(async () => {
    await f.close();
  });
  function enrollment() {
    const key = createECDH('prime256v1');
    key.generateKeys();
    return {
      name: 'Test browser',
      consent: true as const,
      subscription: {
        endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
        keys: {
          p256dh: key.getPublicKey().toString('base64url'),
          auth: randomBytes(16).toString('base64url'),
        },
      },
    };
  }
  async function candidate(extra: Partial<typeof notifications.$inferInsert> = {}) {
    const [row] = await f.db.orm
      .insert(notifications)
      .values({
        id: workKey('ntf'),
        userId: f.userId,
        projectId: f.projectId,
        eventKey: `voice-push:${randomUUID()}`,
        level: 'urgent',
        title: 'Private task name',
        body: 'Private message content',
        status: 'logged',
        createdAt: new Date(now.getTime() - 1000),
        dueAt: now,
        ...extra,
      })
      .returning();
    return row!;
  }
  it('requires explicit owner consent and stores subscription credentials only in the vault', async () => {
    const body = enrollment();
    expect((await f.request('POST', '/api/channels/push', body, false)).statusCode).toBe(401);
    expect(
      (await f.request('POST', '/api/channels/push', body, true, 'https://attacker.test'))
        .statusCode,
    ).toBe(403);
    expect(
      (await f.request('POST', '/api/channels/push', { ...body, consent: false })).statusCode,
    ).toBe(400);
    const response = await f.request('POST', '/api/channels/push', body);
    expect(response.statusCode, response.body).toBe(200);
    const publicStatus = pushStatusSchema.parse(
      (await f.request('GET', '/api/channels/push')).json<unknown>(),
    );
    expect(publicStatus.devices).toHaveLength(1);
    const serialized = JSON.stringify([
      publicStatus,
      await f.db.orm.select().from(pushDevices),
      await f.runtime.vault.list(),
    ]);
    for (const secret of [
      body.subscription.endpoint,
      body.subscription.keys.auth,
      body.subscription.keys.p256dh,
    ])
      expect(serialized).not.toContain(secret);
    expect(
      (await f.db.orm.select().from(secrets).where(eq(secrets.purpose, 'web-push'))).length,
    ).toBeGreaterThan(0);
    await push.enroll(f.userId, body);
    expect((await push.status(f.userId)).devices).toHaveLength(1);
  });
  it('refuses global opt-out, invalid endpoints and another owner revoking a device', async () => {
    const current = await readSettings(f.db),
      body = enrollment();
    await setting('channels', { ...current.channels.value, webPush: false });
    await expect(push.enroll(f.userId, body)).rejects.toMatchObject({ code: 'PUSH_DISABLED' });
    await setting('channels', current.channels.value);
    await expect(
      push.enroll(f.userId, {
        ...body,
        subscription: { ...body.subscription, endpoint: 'https://127.0.0.1/private' },
      }),
    ).rejects.toMatchObject({ code: 'PUSH_INVALID' });
    const device = await push.enroll(f.userId, body);
    await expect(push.revoke('another-owner', device.id)).rejects.toMatchObject({
      code: 'PUSH_NOT_FOUND',
    });
  });
  it('delivers to two browsers once and consumes one logical interruption under concurrent ticks', async () => {
    await push.enroll(f.userId, enrollment());
    await push.enroll(f.userId, enrollment());
    const event = await candidate();
    await Promise.all([push.tick(now), push.tick(now)]);
    await push.tick(now);
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.every(
        (call) => call[1] === 'activity' && call[2] === `notification:${event.id}`,
      ),
    ).toBe(true);
    expect(await f.db.orm.select().from(notificationInterruptions)).toHaveLength(1);
    expect((await f.db.orm.select().from(pushDeliveries)).map((row) => row.status)).toEqual([
      'done',
      'done',
    ]);
  });
  it('defers quiet hours, caps urgent bursts and honors current routing', async () => {
    await push.enroll(f.userId, enrollment());
    const current = await readSettings(f.db);
    await setting('profile', {
      ...current.profile.value,
      quietStart: '08:00',
      quietEnd: '10:00',
      noiseBudget: 1,
    });
    await candidate();
    await push.tick(now);
    expect(send).not.toHaveBeenCalled();
    await setting('profile', { ...current.profile.value, noiseBudget: 1 });
    await candidate();
    await candidate();
    await push.tick(now);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await f.db.orm.select().from(notificationInterruptions)).toHaveLength(1);
    send.mockClear();
    await setting('channels', { ...current.channels.value, urgent: 'telegram' });
    await candidate();
    await push.tick(now);
    expect(send).not.toHaveBeenCalled();
  });
  it('honors per-device revocation, a locked vault, kill switch and restrictive policies', async () => {
    const device = await push.enroll(f.userId, enrollment());
    await candidate();
    await f.runtime.vault.lock();
    try {
      await push.tick(now);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await f.runtime.vault.unlock('phase4-vault-passphrase-198723');
    }
    await f.db.orm.update(executionControl).set({ paused: true });
    await push.tick(now);
    expect(send).not.toHaveBeenCalled();
    await f.db.orm.update(executionControl).set({ paused: false });
    const current = await readSettings(f.db);
    await setting('security', {
      ...current.security.value,
      rules: [
        {
          id: 'push-review',
          scope: { type: 'global' },
          match: { tool: 'push.notify' },
          when: [],
          action: 'ask',
        },
      ],
    });
    await push.tick(now);
    expect(send).not.toHaveBeenCalled();
    await setting('security', current.security.value);
    await push.revoke(f.userId, device.id);
    await candidate();
    await push.tick(now);
    expect(send).not.toHaveBeenCalled();
  });
  it('retains uncertain delivery receipts and revokes expired browser subscriptions without retry', async () => {
    const device = await push.enroll(f.userId, enrollment());
    await candidate();
    send.mockRejectedValueOnce(new PushDeliveryError(false));
    await push.tick(now);
    await push.tick(now);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await push.status(f.userId)).deliveries[0]?.status).toBe('uncertain');
    const next = await candidate();
    await f.db.orm
      .insert(pushDeliveries)
      .values({ id: workKey('pdl'), deviceId: device.id, eventKey: `notification:${next.id}` });
    await push.tick(now);
    expect(send).toHaveBeenCalledTimes(1);
    await candidate();
    send.mockRejectedValueOnce(new PushDeliveryError(true));
    await push.tick(now);
    expect((await push.status(f.userId)).devices[0]?.revokedAt).not.toBeNull();
  });
  it('enforces explicit denials and hourly policy limits across device fanout', async () => {
    await push.enroll(f.userId, enrollment());
    await push.enroll(f.userId, enrollment());
    const current = await readSettings(f.db);
    await setting('security', {
      ...current.security.value,
      rules: [
        {
          id: 'push-cap',
          scope: { type: 'global' },
          match: { tool: 'push.notify' },
          when: [],
          action: 'allow',
          limits: { perHour: 1 },
        },
      ],
    });
    await candidate();
    await push.tick(now);
    expect(send).toHaveBeenCalledTimes(2);
    await candidate();
    await push.tick(now);
    expect(send).toHaveBeenCalledTimes(2);
    await setting('security', {
      ...current.security.value,
      rules: [
        {
          id: 'no-push',
          scope: { type: 'global' },
          match: { tool: 'push.notify' },
          when: [],
          action: 'deny',
        },
      ],
    });
    await candidate();
    await push.tick(now);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('does not backfill older notifications after enrollment or global re-enablement', async () => {
    const device = await push.enroll(f.userId, enrollment());
    await candidate();
    await f.db.orm.update(pushDevices).set({ createdAt: now }).where(eq(pushDevices.id, device.id));
    await push.tick(now);
    expect(send).not.toHaveBeenCalled();
    await f.db.orm.update(pushDevices).set({ createdAt: new Date('2032-06-09T09:00:00Z') });
    await f.db.orm
      .update(settingsTable)
      .set({ updatedAt: now })
      .where(eq(settingsTable.namespace, 'channels'));
    await push.tick(now);
    expect(send).not.toHaveBeenCalled();
    await candidate({
      createdAt: new Date(now.getTime() + 1000),
      dueAt: new Date(now.getTime() + 2000),
    });
    await push.tick(new Date(now.getTime() + 2000));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('fans out a digest as one interruption and never sends its title or body', async () => {
    await push.enroll(f.userId, enrollment());
    await push.enroll(f.userId, enrollment());
    const notification = await candidate({ status: 'digested', level: 'normal' });
    const id = workKey('dig');
    await f.db.orm.insert(digests).values({
      id,
      userId: f.userId,
      projectId: f.projectId,
      title: 'Secret title',
      body: 'Private digest body',
      itemCount: 1,
      notificationIds: [notification.id],
      createdAt: now,
      deliveryStatus: 'web',
    });
    await push.tick(now);
    await push.tick(now);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((call) => call.slice(1))).toEqual([
      ['digest', `digest:${id}`],
      ['digest', `digest:${id}`],
    ]);
    expect(await f.db.orm.select().from(notificationInterruptions)).toHaveLength(1);
  });
});
