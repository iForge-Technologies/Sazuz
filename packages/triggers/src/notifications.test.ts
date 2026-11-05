import { defaultSettings } from '@sazuz/config/settings';
import { describe, expect, it } from 'vitest';
import {
  classifyNotification,
  groupDigest,
  isQuietTime,
  nextDigestAt,
  nextQuietEnd,
  notificationDayKey,
  renderDigest,
  routeNotification,
  type DigestItem,
  type NotificationRoutingInput,
} from './notifications.js';

const now = new Date('2026-11-03T08:00:00.000Z');
const input: NotificationRoutingInput = {
  priority: 'normal',
  critical: false,
  profile: { ...defaultSettings.profile, quietStart: '22:00', quietEnd: '07:00' },
  timezone: 'UTC',
  channels: { urgent: 'telegram', digest: 'web' },
  interruptionsToday: 0,
  now,
};
const quiet = { quietStart: '22:00', quietEnd: '07:00', timezone: 'UTC' };

describe('notification quiet hours and digests', () => {
  it('handles both midnight-crossing and daytime quiet intervals with exact boundaries', () => {
    for (const [instant, expected] of [
      ['2026-11-03T21:59:59.999Z', false],
      ['2026-11-03T22:00:00.000Z', true],
      ['2026-11-04T06:59:59.999Z', true],
      ['2026-11-04T07:00:00.000Z', false],
    ] as const)
      expect(isQuietTime({ ...quiet, now: new Date(instant) })).toBe(expected);
    expect(
      isQuietTime({
        quietStart: '12:00',
        quietEnd: '13:00',
        timezone: 'UTC',
        now: new Date('2026-11-03T12:30:00Z'),
      }),
    ).toBe(true);
    expect(
      isQuietTime({
        quietStart: '12:00',
        quietEnd: '12:00',
        timezone: 'UTC',
        now: new Date('2026-11-03T12:00:00Z'),
      }),
    ).toBe(false);
    expect(nextQuietEnd({ ...quiet, now: new Date('2026-11-03T23:15:30Z') })).toBe(
      '2026-11-04T07:00:00.000Z',
    );
  });

  it('uses actual instants across spring gaps and the repeated fall hour', () => {
    expect(
      nextQuietEnd({
        quietStart: '22:00',
        quietEnd: '02:30',
        timezone: 'America/New_York',
        now: new Date('2026-03-08T06:00:00Z'),
      }),
    ).toBe('2026-03-08T07:00:00.000Z');
    expect(
      nextQuietEnd({
        quietStart: '22:00',
        quietEnd: '02:30',
        timezone: 'America/New_York',
        now: new Date('2026-11-01T05:30:00Z'),
      }),
    ).toBe('2026-11-01T07:30:00.000Z');
    expect(
      nextQuietEnd({
        quietStart: '00:00',
        quietEnd: '01:30',
        timezone: 'America/New_York',
        now: new Date('2026-11-01T06:15:00Z'),
      }),
    ).toBe('2026-11-01T06:30:00.000Z');
    expect(
      isQuietTime({ ...quiet, timezone: 'Asia/Kolkata', now: new Date('2026-11-03T18:00:00Z') }),
    ).toBe(true);
  });

  it('selects the next configured digest slot, including a slot at this exact instant', () => {
    const settings = { ...quiet, digestTimes: ['18:00', '09:00', '09:00'] };
    expect(nextDigestAt({ ...settings, now })).toBe('2026-11-03T09:00:00.000Z');
    expect(nextDigestAt({ ...settings, now: new Date('2026-11-03T09:00:00Z') })).toBe(
      '2026-11-03T09:00:00.000Z',
    );
    expect(nextDigestAt({ ...settings, now: new Date('2026-11-03T18:00:00.001Z') })).toBe(
      '2026-11-04T09:00:00.000Z',
    );
    expect(nextDigestAt({ ...settings, digestTimes: [], now })).toBeNull();
  });

  it('defers digest slots inside quiet hours and joins a previously deferred overnight slot', () => {
    expect(
      nextDigestAt({ ...quiet, digestTimes: ['23:00'], now: new Date('2026-11-03T21:00:00Z') }),
    ).toBe('2026-11-04T07:00:00.000Z');
    expect(
      nextDigestAt({ ...quiet, digestTimes: ['23:00'], now: new Date('2026-11-04T06:30:00Z') }),
    ).toBe('2026-11-04T07:00:00.000Z');
  });

  it('applies cron timezone semantics to digest slots through DST', () => {
    const settings = { quietStart: '00:00', quietEnd: '00:00', timezone: 'America/New_York' };
    expect(
      nextDigestAt({ ...settings, digestTimes: ['02:30'], now: new Date('2026-03-08T06:00:00Z') }),
    ).toBe('2026-03-08T07:30:00.000Z');
    expect(
      nextDigestAt({ ...settings, digestTimes: ['01:30'], now: new Date('2026-11-01T05:45:00Z') }),
    ).toBe('2026-11-02T06:30:00.000Z');
    expect(
      nextDigestAt({ ...settings, digestTimes: ['09:00'], now: new Date('2026-03-07T15:00:00Z') }),
    ).toBe('2026-03-08T13:00:00.000Z');
  });

  it('routes urgent pushes, normal digests and low priority history using configured channels', () => {
    expect(routeNotification({ ...input, priority: 'urgent' })).toMatchObject({
      route: 'push',
      channel: 'telegram',
      deliverAt: now.toISOString(),
      reason: 'urgent',
    });
    expect(routeNotification(input)).toMatchObject({
      route: 'digest',
      channel: 'web',
      deliverAt: '2026-11-03T09:00:00.000Z',
      reason: 'normal',
    });
    expect(routeNotification({ ...input, priority: 'low' })).toMatchObject({
      route: 'logged',
      channel: null,
      deliverAt: null,
      reason: 'low',
    });
    expect(
      routeNotification({ ...input, profile: { ...input.profile, digestTimes: [] } }),
    ).toMatchObject({ route: 'logged', reason: 'digests-disabled' });
  });

  it('defers urgent pushes during quiet time, merges excess into a digest and permits critical bypass', () => {
    const atNight = {
      ...input,
      priority: 'urgent' as const,
      now: new Date('2026-11-03T23:00:00Z'),
    };
    expect(routeNotification(atNight)).toMatchObject({
      route: 'push',
      deliverAt: '2026-11-04T07:00:00.000Z',
      reason: 'quiet-hours',
    });
    expect(
      routeNotification({ ...input, priority: 'urgent', interruptionsToday: 5 }),
    ).toMatchObject({
      route: 'digest',
      deliverAt: '2026-11-03T09:00:00.000Z',
      reason: 'noise-budget',
    });
    expect(
      routeNotification({
        ...input,
        priority: 'urgent',
        profile: { ...input.profile, noiseBudget: 0 },
      }),
    ).toMatchObject({ route: 'digest', reason: 'noise-budget' });
    expect(routeNotification({ ...atNight, critical: true, interruptionsToday: 0 })).toMatchObject({
      route: 'push',
      deliverAt: '2026-11-03T23:00:00.000Z',
      reason: 'critical',
    });
    expect(
      routeNotification({ ...atNight, critical: true, interruptionsToday: 100 }),
    ).toMatchObject({ route: 'digest', reason: 'noise-budget' });
  });

  it('scopes interruption counters to the local calendar day, without adding 24 hours', () => {
    const at = new Date('2026-11-03T19:00:00Z');
    expect(notificationDayKey({ now: at, timezone: 'UTC' })).toBe('2026-11-03');
    expect(notificationDayKey({ now: at, timezone: 'Asia/Kolkata' })).toBe('2026-11-04');
    expect(
      notificationDayKey({ now: new Date('2026-11-01T04:30:00Z'), timezone: 'America/New_York' }),
    ).toBe('2026-11-01');
    expect(
      notificationDayKey({ now: new Date('2026-11-02T04:30:00Z'), timezone: 'America/New_York' }),
    ).toBe('2026-11-01');
  });

  it('combines trusted rule signals and validated model classification without model critical bypass', () => {
    expect(
      classifyNotification({
        now,
        signals: { securityAlert: true },
        modelResult: { priority: 'low', reason: 'Low model score' },
      }),
    ).toMatchObject({ priority: 'urgent', critical: false });
    expect(
      classifyNotification({
        now,
        signals: { vipSender: true, deadlineAt: '2026-11-03T20:00:00Z', moneyInvolved: true },
        modelResult: { priority: 'normal', reason: 'Combined rules apply' },
      }),
    ).toMatchObject({ priority: 'urgent' });
    expect(
      classifyNotification({
        now,
        signals: {},
        modelResult: { priority: 'low', reason: 'No action needed' },
      }),
    ).toMatchObject({ priority: 'low' });
    expect(classifyNotification({ now, signals: { critical: true } })).toMatchObject({
      priority: 'urgent',
      critical: true,
      score: 100,
    });
    expect(() =>
      classifyNotification({
        now,
        signals: {},
        modelResult: { priority: 'urgent', critical: true, reason: 'Invalid extra field' },
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_NOTIFICATION' }));
  });
});

describe('digest delivery assembly', () => {
  const item = (id: string, groupKey = 'Morning Brief'): DigestItem => ({
    id,
    groupKey,
    title: `Item ${id}`,
    body: 'A useful update.',
    priority: 'normal',
    createdAt: now.toISOString(),
  });

  it('groups and orders deterministically, deduplicates identity and excludes logged low items', () => {
    const items = [
      item('b'),
      { ...item('a'), priority: 'urgent' as const },
      item('c', 'Work'),
      item('b'),
      { ...item('low'), priority: 'low' as const },
    ];
    const groups = groupDigest(items);
    expect(groups).toEqual(groupDigest([...items].reverse()));
    expect(groups.map((group) => group.items.map((entry) => entry.id))).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
    expect(renderDigest(items)).toEqual(renderDigest([...items].reverse()));
    expect(renderDigest(items).notificationIds).toEqual(['a', 'b', 'c']);
    expect(renderDigest(items).body).toContain('Morning Brief');
    expect(() =>
      groupDigest([item('duplicate'), { ...item('duplicate'), body: 'Different record' }]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_NOTIFICATION' }));
  });

  it('uses bounded learned bias without changing critical status or losing low-level defaults', () => {
    expect(classifyNotification({ now, signals: {}, baseline: 'low' })).toMatchObject({
      priority: 'low',
      score: 0,
    });
    expect(
      classifyNotification({ now, signals: { explicitUrgent: true }, bias: -20 }),
    ).toMatchObject({ priority: 'normal', score: 50 });
    expect(classifyNotification({ now, signals: {}, baseline: 'normal', bias: 40 })).toMatchObject({
      priority: 'urgent',
      score: 70,
    });
    expect(classifyNotification({ now, signals: { critical: true }, bias: -40 })).toMatchObject({
      priority: 'urgent',
      critical: true,
      score: 100,
    });
  });
  it('applies the daily cap even when a critical caller supplied a low baseline', () => {
    expect(
      routeNotification({
        ...input,
        priority: 'low',
        critical: true,
        interruptionsToday: input.profile.noiseBudget,
      }),
    ).toMatchObject({ route: 'digest', reason: 'noise-budget' });
  });
  it('bounds delivery text and lists pending IDs so an oversized digest never loses events', () => {
    const items = Array.from({ length: 15 }, (_, index) => ({
      ...item(String(index).padStart(2, '0')),
      body: 'Long summary '.repeat(100),
    }));
    const delivery = renderDigest(items, 1000);
    expect(delivery.body.length).toBeLessThanOrEqual(1000);
    expect(delivery.notificationIds.length).toBeGreaterThan(0);
    expect(delivery.remainingIds.length).toBeGreaterThan(0);
    expect([...delivery.notificationIds, ...delivery.remainingIds].sort()).toEqual(
      items.map((entry) => entry.id).sort(),
    );
    expect(delivery.dedupeKey).toBe(renderDigest(items, 1000).dedupeKey);
    expect(delivery.dedupeKey).not.toBe(renderDigest(items, 3500).dedupeKey);
    expect(
      renderDigest(
        [{ ...item('single', 'x'.repeat(160)), title: 'x'.repeat(240), body: 'y'.repeat(24000) }],
        256,
      ).notificationIds,
    ).toEqual(['single']);
  });
});
