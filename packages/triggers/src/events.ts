import { createHash } from 'node:crypto';
import { z } from 'zod';
import { triggerCandidateSchema, triggerIdSchema, type TriggerCandidate } from './contracts.js';
import { TriggerError } from './errors.js';

const eventKeyInputSchema = z.strictObject({
  triggerId: triggerIdSchema,
  kind: z.enum(['cron', 'webhook', 'rss', 'imap']),
  sourceId: z.string().min(1).max(16_384),
});

/** Length framing prevents ambiguous concatenation; uniqueness is enforced by the database. */
export function triggerEventKey(
  triggerId: string,
  kind: TriggerCandidate['kind'],
  sourceId: string,
) {
  const input = eventKeyInputSchema.safeParse({ triggerId, kind, sourceId });
  if (!input.success) throw new TriggerError('INVALID_TRIGGER');
  return createHash('sha256')
    .update(JSON.stringify(['sazuz.trigger.v1', input.data.triggerId, kind, sourceId]))
    .digest('hex');
}

export function cronTriggerCandidate(triggerId: string, scheduledAt: Date): TriggerCandidate {
  if (!z.date().safeParse(scheduledAt).success) throw new TriggerError('INVALID_TRIGGER');
  const occurrence = scheduledAt.toISOString();
  return triggerCandidateSchema.parse({
    triggerId,
    kind: 'cron',
    dedupeKey: triggerEventKey(triggerId, 'cron', occurrence),
    occurredAt: occurrence,
    untrusted: false,
    payload: { scheduledAt: occurrence },
  });
}

export function renderTriggerPayload(candidate: TriggerCandidate): string {
  const parsed = triggerCandidateSchema.safeParse(candidate);
  if (!parsed.success) throw new TriggerError('INVALID_TRIGGER');
  let text: string;
  try {
    text = JSON.stringify(parsed.data.payload);
  } catch {
    throw new TriggerError('INVALID_TRIGGER');
  }
  return parsed.data.untrusted
    ? `<untrusted>\n${text.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}\n</untrusted>`
    : text;
}
