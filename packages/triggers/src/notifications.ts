import { createHash } from 'node:crypto';
import { settingsSchemas } from '@sazuz/config/settings';
import { z } from 'zod';
import { clockSchema, timezoneSchema } from './contracts.js';
import { TriggerError } from './errors.js';
import { nextCronOccurrences } from './schedules.js';

export const notificationPrioritySchema = z.enum(['urgent', 'normal', 'low']);
export type NotificationPriority = z.infer<typeof notificationPrioritySchema>;
export const notificationProfileSchema = settingsSchemas.profile
  .pick({ quietStart: true, quietEnd: true, digestTimes: true, noiseBudget: true })
  .strip();
export const notificationChannelsSchema = settingsSchemas.channels
  .pick({ urgent: true, digest: true })
  .strip();
export type NotificationProfile = z.infer<typeof notificationProfileSchema>;
export type NotificationChannels = z.infer<typeof notificationChannelsSchema>;
export type NotificationChannel = NotificationChannels['urgent'];

const quietInputSchema = z.strictObject({
  quietStart: clockSchema,
  quietEnd: clockSchema,
  timezone: timezoneSchema,
  now: z.date(),
});
export interface QuietTimeInput {
  quietStart: string;
  quietEnd: string;
  timezone: string;
  now: Date;
}
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timezone);
  if (existing !== undefined) return existing;
  const created = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    calendar: 'iso8601',
    numberingSystem: 'latn',
  });
  if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!);
  formatters.set(timezone, created);
  return created;
}

function localParts(timezone: string, date: Date): Record<string, string> {
  return Object.fromEntries(
    formatter(timezone)
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
}

function clockMinutes(clock: string): number {
  const [hour, minute] = clock.split(':').map(Number);
  return hour! * 60 + minute!;
}

function quietAt(input: QuietTimeInput): boolean {
  const start = clockMinutes(input.quietStart);
  const end = clockMinutes(input.quietEnd);
  if (start === end) return false;
  const local = localParts(input.timezone, input.now);
  const minute = Number(local.hour) * 60 + Number(local.minute);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function isQuietTime(input: QuietTimeInput): boolean {
  const parsed = quietInputSchema.safeParse(input);
  if (!parsed.success) throw new TriggerError('INVALID_NOTIFICATION');
  return quietAt(parsed.data);
}

/** Wall-clock intervals include their start and exclude their end. Equal times disable quiet hours. */
export function nextQuietEnd(input: QuietTimeInput): string | null {
  const parsed = quietInputSchema.safeParse(input);
  if (!parsed.success) throw new TriggerError('INVALID_NOTIFICATION');
  if (!quietAt(parsed.data)) return null;
  const nextMinute = Math.floor(parsed.data.now.getTime() / 60_000) * 60_000 + 60_000;
  // Scan instants, not assumed offsets: spring gaps and both fall-back hours remain correct.
  for (let minute = 0; minute < 72 * 60; minute += 1) {
    const now = new Date(nextMinute + minute * 60_000);
    if (!quietAt({ ...parsed.data, now })) return now.toISOString();
  }
  throw new TriggerError('INVALID_NOTIFICATION');
}

export function notificationDayKey(input: { timezone: string; now: Date }): string {
  const parsed = z.strictObject({ timezone: timezoneSchema, now: z.date() }).safeParse(input);
  if (!parsed.success) throw new TriggerError('INVALID_NOTIFICATION');
  const local = localParts(parsed.data.timezone, parsed.data.now);
  return `${local.year}-${local.month}-${local.day}`;
}

export function nextDigestAt(
  input: QuietTimeInput & { digestTimes: readonly string[] },
): string | null {
  const parsed = quietInputSchema
    .extend({ digestTimes: settingsSchemas.profile.shape.digestTimes })
    .safeParse(input);
  if (!parsed.success) throw new TriggerError('INVALID_NOTIFICATION');
  let earliest: string | null = null;
  for (const clock of new Set(parsed.data.digestTimes)) {
    const [hour, minute] = clock.split(':').map(Number);
    // Include the previous slot: it may have been deferred through an overnight quiet interval.
    const occurrences = nextCronOccurrences({
      expression: `${minute!} ${hour!} * * *`,
      timezone: parsed.data.timezone,
      now: new Date(parsed.data.now.getTime() - 36 * 60 * 60_000),
      count: 4,
    });
    for (const occurrence of occurrences) {
      const quietInput = {
        quietStart: parsed.data.quietStart,
        quietEnd: parsed.data.quietEnd,
        timezone: parsed.data.timezone,
        now: new Date(occurrence),
      };
      const candidate = nextQuietEnd(quietInput) ?? occurrence;
      if (new Date(candidate).getTime() < parsed.data.now.getTime()) continue;
      if (earliest === null || candidate < earliest) earliest = candidate;
    }
  }
  return earliest;
}

export interface NotificationRoutingInput {
  priority: NotificationPriority;
  critical?: boolean;
  profile: NotificationProfile;
  timezone: string;
  channels: NotificationChannels;
  interruptionsToday: number;
  now: Date;
}
export interface NotificationRoute {
  route: 'push' | 'digest' | 'logged';
  channel: NotificationChannel | null;
  deliverAt: string | null;
  dayKey: string;
  reason:
    'critical' | 'urgent' | 'quiet-hours' | 'noise-budget' | 'normal' | 'low' | 'digests-disabled';
}

/** Caller atomically reserves pushes against its durable daily count, then persists the decision. */
export function routeNotification(input: NotificationRoutingInput): NotificationRoute {
  const parsed = z
    .strictObject({
      priority: notificationPrioritySchema,
      critical: z.boolean().default(false),
      profile: notificationProfileSchema,
      timezone: timezoneSchema,
      channels: notificationChannelsSchema,
      interruptionsToday: z.number().int().min(0).max(1_000_000),
      now: z.date(),
    })
    .safeParse(input);
  if (!parsed.success) throw new TriggerError('INVALID_NOTIFICATION');
  const item = parsed.data;
  const dayKey = notificationDayKey({ timezone: item.timezone, now: item.now });
  const quietInput = {
    quietStart: item.profile.quietStart,
    quietEnd: item.profile.quietEnd,
    timezone: item.timezone,
    now: item.now,
  };
  if (item.critical && item.interruptionsToday < item.profile.noiseBudget)
    return {
      route: 'push',
      channel: item.channels.urgent,
      deliverAt: item.now.toISOString(),
      dayKey,
      reason: 'critical',
    };
  if (item.priority === 'low' && !item.critical)
    return { route: 'logged', channel: null, deliverAt: null, dayKey, reason: 'low' };
  if (
    (item.priority === 'normal' && !item.critical) ||
    item.interruptionsToday >= item.profile.noiseBudget
  ) {
    const deliverAt = nextDigestAt({ ...quietInput, digestTimes: item.profile.digestTimes });
    return deliverAt === null
      ? { route: 'logged', channel: null, deliverAt: null, dayKey, reason: 'digests-disabled' }
      : {
          route: 'digest',
          channel: item.channels.digest,
          deliverAt,
          dayKey,
          reason: item.interruptionsToday >= item.profile.noiseBudget ? 'noise-budget' : 'normal',
        };
  }
  const end = nextQuietEnd(quietInput);
  return {
    route: 'push',
    channel: item.channels.urgent,
    deliverAt: end ?? item.now.toISOString(),
    dayKey,
    reason: end === null ? 'urgent' : 'quiet-hours',
  };
}

export const notificationClassificationSchema = z.strictObject({
  priority: notificationPrioritySchema,
  reason: z.string().trim().min(1).max(400),
});

export function classifyNotification(input: {
  now: Date;
  baseline?: NotificationPriority;
  bias?: number;
  signals: {
    vipSender?: boolean;
    deadlineAt?: string | null;
    moneyInvolved?: boolean;
    securityAlert?: boolean;
    explicitUrgent?: boolean;
    critical?: boolean;
  };
  modelResult?: unknown;
}): { priority: NotificationPriority; critical: boolean; score: number } {
  const parsed = z
    .strictObject({
      now: z.date(),
      baseline: notificationPrioritySchema.default('normal'),
      bias: z.number().int().min(-40).max(40).default(0),
      signals: z.strictObject({
        vipSender: z.boolean().default(false),
        deadlineAt: z.iso.datetime().nullable().default(null),
        moneyInvolved: z.boolean().default(false),
        securityAlert: z.boolean().default(false),
        explicitUrgent: z.boolean().default(false),
        critical: z.boolean().default(false),
      }),
      modelResult: notificationClassificationSchema.optional(),
    })
    .safeParse(input);
  if (!parsed.success) throw new TriggerError('INVALID_NOTIFICATION');
  const { signals, now, modelResult } = parsed.data;
  const deadlineMs =
    signals.deadlineAt === null ? null : new Date(signals.deadlineAt).getTime() - now.getTime();
  const ruleScore =
    (signals.vipSender ? 30 : 0) +
    (deadlineMs !== null && deadlineMs >= 0 && deadlineMs < 86_400_000 ? 30 : 0) +
    (signals.moneyInvolved ? 20 : 0) +
    (signals.securityAlert ? 80 : 0) +
    (signals.explicitUrgent ? 70 : 0);
  const modelScore = { low: 0, normal: 30, urgent: 70 }[
    modelResult?.priority ?? parsed.data.baseline
  ];
  const score = signals.critical
    ? 100
    : Math.max(0, Math.min(100, Math.max(ruleScore, modelScore) + parsed.data.bias));
  return {
    priority: score >= 70 ? 'urgent' : score >= 20 ? 'normal' : 'low',
    critical: signals.critical,
    score,
  };
}

export const digestItemSchema = z.strictObject({
  id: z.string().min(1).max(120),
  groupKey: z.string().min(1).max(160),
  title: z.string().max(240),
  body: z.string().max(24_000),
  priority: notificationPrioritySchema,
  createdAt: z.iso.datetime(),
});
export type DigestItem = z.infer<typeof digestItemSchema>;
export interface DigestGroup {
  groupKey: string;
  items: DigestItem[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function groupDigest(input: readonly DigestItem[]): DigestGroup[] {
  const parsed = z.array(digestItemSchema).max(1000).safeParse(input);
  if (!parsed.success) throw new TriggerError('INVALID_NOTIFICATION');
  const unique = new Map<string, DigestItem>();
  for (const item of parsed.data) {
    if (item.priority === 'low') continue;
    const existing = unique.get(item.id);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(item))
      throw new TriggerError('INVALID_NOTIFICATION');
    unique.set(item.id, item);
  }
  const ordered = [...unique.values()].sort((left, right) => {
    const priority = { urgent: 0, normal: 1, low: 2 };
    return (
      compareText(left.groupKey, right.groupKey) ||
      priority[left.priority] - priority[right.priority] ||
      compareText(left.createdAt, right.createdAt) ||
      compareText(left.id, right.id)
    );
  });
  const groups: DigestGroup[] = [];
  for (const item of ordered) {
    let group = groups.at(-1);
    if (group?.groupKey !== item.groupKey) {
      group = { groupKey: item.groupKey, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

export interface DigestDelivery {
  title: string;
  body: string;
  notificationIds: string[];
  remainingIds: string[];
  dedupeKey: string;
}

/** Plain text only; the channel must not enable HTML/Markdown interpretation of source content. */
export function renderDigest(input: readonly DigestItem[], maxCharacters = 3500): DigestDelivery {
  if (!z.number().int().min(256).max(4000).safeParse(maxCharacters).success)
    throw new TriggerError('INVALID_NOTIFICATION');
  const groups = groupDigest(input);
  const notificationIds: string[] = [];
  const remainingIds: string[] = [];
  let body = 'Sazuz digest';
  for (const group of groups) {
    let headingAdded = false;
    for (const item of group.items) {
      const title = item.title.replace(/[\r\n]+/g, ' ').slice(0, 180);
      const summary = item.body.replace(/\s+/g, ' ').trim();
      const snippet = summary.length > 400 ? `${summary.slice(0, 399)}…` : summary;
      const heading = headingAdded ? '' : `\n\n${group.groupKey.replace(/[\r\n]+/g, ' ')}`;
      let line = `\n• ${title}${snippet ? ` — ${snippet}` : ''}`;
      const available = maxCharacters - body.length - heading.length;
      if (line.length > available && notificationIds.length === 0 && available >= 80)
        line = `${line.slice(0, available - 1)}…`;
      if (line.length > available) {
        remainingIds.push(item.id);
        continue;
      }
      body += heading + line;
      headingAdded = true;
      notificationIds.push(item.id);
    }
  }
  return {
    title: 'Sazuz digest',
    body,
    notificationIds,
    remainingIds,
    dedupeKey: createHash('sha256')
      .update(JSON.stringify(['sazuz.digest.v1', notificationIds]))
      .digest('hex'),
  };
}
