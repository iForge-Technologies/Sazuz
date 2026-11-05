import { createHash } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { cronExpressionSchema, timezoneSchema } from './contracts.js';
import { TriggerError } from './errors.js';

const scheduleInputSchema = z.strictObject({
  expression: cronExpressionSchema,
  timezone: timezoneSchema,
  now: z.date(),
  count: z.number().int().min(1).max(10).default(5),
});
export interface ScheduleInput {
  expression: string;
  timezone: string;
  now: Date;
  count?: number;
}
export const schedulePreviewSchema = z.strictObject({
  expression: cronExpressionSchema,
  timezone: timezoneSchema,
  occurrences: z.array(z.iso.datetime()).min(1).max(10),
});
export type SchedulePreview = z.infer<typeof schedulePreviewSchema>;

/** Five-field crons, minute resolution, no aliases or nondeterministic H expressions. */
export function nextCronOccurrences(input: ScheduleInput): string[] {
  const parsed = scheduleInputSchema.safeParse(input);
  if (!parsed.success) throw new TriggerError('INVALID_SCHEDULE');
  const { expression, timezone, now, count } = parsed.data;
  const fields = expression.split(/\s+/);
  if (fields.length !== 5 || /\bH(?:\b|\()/i.test(expression))
    throw new TriggerError('INVALID_SCHEDULE');
  try {
    const schedule = CronExpressionParser.parse(`0 ${fields.join(' ')}`, {
      currentDate: now,
      tz: timezone,
      strict: true,
    });
    return Array.from({ length: count }, () => schedule.next().toDate().toISOString());
  } catch {
    throw new TriggerError('INVALID_SCHEDULE');
  }
}

export function previewSchedule(input: ScheduleInput): SchedulePreview {
  const occurrences = nextCronOccurrences(input);
  return schedulePreviewSchema.parse({
    expression: input.expression.trim().split(/\s+/).join(' '),
    timezone: input.timezone,
    occurrences,
  });
}

/** The API stores this binding with its authenticated, expiring review token. */
export function schedulePreviewHash(preview: SchedulePreview): string {
  const parsed = schedulePreviewSchema.safeParse(preview);
  if (!parsed.success) throw new TriggerError('INVALID_SCHEDULE');
  return createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
}

export const naturalLanguageScheduleResultSchema = z.strictObject({
  expression: cronExpressionSchema,
  timezone: timezoneSchema,
  summary: z.string().trim().min(1).max(1000),
});
export interface ScheduleInterpretationInput {
  text: string;
  timezone: string;
}
export type ScheduleInterpreter = (input: ScheduleInterpretationInput) => Promise<unknown>;
export type NaturalLanguageSchedulePreview = SchedulePreview & { summary: string };

/** The caller selects its configured Fast model; provider code stays in @sazuz/llm. */
export async function previewNaturalLanguageSchedule(
  input: ScheduleInterpretationInput & { now: Date },
  interpretFast: ScheduleInterpreter,
): Promise<NaturalLanguageSchedulePreview> {
  const parsed = z
    .strictObject({
      text: z.string().trim().min(1).max(2000),
      timezone: timezoneSchema,
      now: z.date(),
    })
    .safeParse(input);
  if (!parsed.success) throw new TriggerError('INVALID_SCHEDULE');
  let result: unknown;
  try {
    result = await interpretFast({ text: parsed.data.text, timezone: parsed.data.timezone });
  } catch {
    throw new TriggerError('SCHEDULE_MODEL_FAILED');
  }
  const schedule = naturalLanguageScheduleResultSchema.safeParse(result);
  if (!schedule.success) throw new TriggerError('INVALID_SCHEDULE_RESULT');
  const preview = previewSchedule({
    expression: schedule.data.expression,
    timezone: schedule.data.timezone,
    now: parsed.data.now,
  });
  return { ...preview, summary: schedule.data.summary };
}
