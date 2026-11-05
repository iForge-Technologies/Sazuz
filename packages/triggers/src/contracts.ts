import { secretRefSchema, settingsSchemas } from '@sazuz/config/settings';
import { z } from 'zod';

export const timezoneSchema = settingsSchemas.general.shape.timezone;
export const clockSchema = settingsSchemas.profile.shape.quietStart;
export const triggerIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,119}$/);
export const pollIntervalSchema = z.number().int().min(60).max(86_400);
export const cronExpressionSchema = z.string().trim().min(9).max(100);

const feedUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash
      );
    } catch {
      return false;
    }
  });

export const cronTriggerConfigSchema = z.strictObject({
  kind: z.literal('cron'),
  expression: cronExpressionSchema,
  timezone: timezoneSchema,
});
export const webhookTriggerConfigSchema = z.strictObject({
  kind: z.literal('webhook'),
  secretRef: secretRefSchema,
});
export const rssTriggerConfigSchema = z.strictObject({
  kind: z.literal('rss'),
  url: feedUrlSchema,
  pollIntervalSeconds: pollIntervalSchema,
});
export const imapTriggerConfigSchema = z.strictObject({
  kind: z.literal('imap'),
  connectorId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  mailbox: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]+$/)
    .refine((value) => !value.includes('\0'))
    .default('INBOX'),
  pollIntervalSeconds: pollIntervalSchema,
});
export const triggerConfigSchema = z.discriminatedUnion('kind', [
  cronTriggerConfigSchema,
  webhookTriggerConfigSchema,
  rssTriggerConfigSchema,
  imapTriggerConfigSchema,
]);
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;
export type CronTriggerConfig = z.infer<typeof cronTriggerConfigSchema>;
export type RssTriggerConfig = z.infer<typeof rssTriggerConfigSchema>;
export type ImapTriggerConfig = z.infer<typeof imapTriggerConfigSchema>;

export const triggerCandidateSchema = z.strictObject({
  triggerId: triggerIdSchema,
  kind: z.enum(['cron', 'webhook', 'rss', 'imap']),
  dedupeKey: z.string().regex(/^[a-f0-9]{64}$/),
  occurredAt: z.iso.datetime(),
  untrusted: z.boolean(),
  payload: z.record(z.string(), z.unknown()),
});
export type TriggerCandidate = z.infer<typeof triggerCandidateSchema>;
