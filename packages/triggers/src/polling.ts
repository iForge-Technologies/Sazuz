import { z } from 'zod';
import {
  imapTriggerConfigSchema,
  pollIntervalSchema,
  triggerIdSchema,
  type ImapTriggerConfig,
  type TriggerCandidate,
} from './contracts.js';
import { TriggerError } from './errors.js';
import { triggerEventKey } from './events.js';

const maxUid = 4_294_967_295;
const uidValiditySchema = z
  .string()
  .regex(/^[1-9]\d{0,9}$/)
  .refine((value) => Number(value) <= maxUid);
export const imapCursorSchema = z
  .strictObject({
    uidValidity: uidValiditySchema.nullable(),
    lastUid: z.number().int().min(0).max(maxUid),
  })
  .refine((cursor) => cursor.uidValidity !== null || cursor.lastUid === 0);
export type ImapCursor = z.infer<typeof imapCursorSchema>;
export const initialImapCursor: Readonly<ImapCursor> = Object.freeze({
  uidValidity: null,
  lastUid: 0,
});
export const imapPollMessageSchema = z.strictObject({
  uid: z.number().int().min(1).max(maxUid),
  messageId: z.string().max(1000).optional(),
  subject: z.string().max(2000),
  from: z.string().max(4000),
  text: z.string().max(131_072),
  receivedAt: z.iso.datetime(),
});
export type ImapPollMessage = z.infer<typeof imapPollMessageSchema>;
export const imapListingSchema = z.strictObject({
  uidValidity: uidValiditySchema,
  messages: z.array(imapPollMessageSchema).max(100),
  hasMore: z.boolean(),
  scannedThrough: z.number().int().min(0).max(maxUid).optional(),
});
export type ImapListing = z.infer<typeof imapListingSchema>;
export interface ImapListingRequest {
  connectorId: string;
  mailbox: string;
  afterUid: number;
  uidValidity: string | null;
  limit: number;
  signal: AbortSignal;
}
export interface ImapPollingDependencies {
  listMessages: (request: ImapListingRequest) => Promise<unknown>;
}
export interface ImapPollResult {
  candidates: TriggerCandidate[];
  nextCursor: ImapCursor;
  hasMore: boolean;
  nextPollAt: string;
}

/** Return a commit proposal. Caller stores candidates, outbox and cursor in one DB transaction. */
export async function pollImapTrigger(
  input: {
    triggerId: string;
    config: ImapTriggerConfig;
    cursor: ImapCursor;
    now: Date;
    signal: AbortSignal;
    limit?: number;
  },
  dependencies: ImapPollingDependencies,
): Promise<ImapPollResult> {
  const parsed = z
    .strictObject({
      triggerId: triggerIdSchema,
      config: imapTriggerConfigSchema,
      cursor: imapCursorSchema,
      now: z.date(),
      signal: z.instanceof(AbortSignal),
      limit: z.number().int().min(1).max(100).default(100),
    })
    .safeParse(input);
  if (!parsed.success) throw new TriggerError('INVALID_TRIGGER');
  const { triggerId, config, cursor, now, signal, limit } = parsed.data;
  if (signal.aborted) throw new TriggerError('POLL_ABORTED');
  let result: unknown;
  try {
    result = await dependencies.listMessages({
      connectorId: config.connectorId,
      mailbox: config.mailbox,
      afterUid: cursor.lastUid,
      uidValidity: cursor.uidValidity,
      limit,
      signal,
    });
  } catch {
    throw new TriggerError(signal.aborted ? 'POLL_ABORTED' : 'POLL_FAILED');
  }
  if (signal.aborted) throw new TriggerError('POLL_ABORTED');
  const listing = imapListingSchema.safeParse(result);
  if (!listing.success || listing.data.messages.length > limit)
    throw new TriggerError('INVALID_POLL_RESULT');
  const previousUid = cursor.uidValidity === listing.data.uidValidity ? cursor.lastUid : 0;
  const messages = [...listing.data.messages].sort((a, b) => a.uid - b.uid);
  const lastMessageUid = messages.at(-1)?.uid ?? 0;
  const scannedThrough = listing.data.scannedThrough ?? Math.max(lastMessageUid, previousUid);
  if (
    scannedThrough < lastMessageUid ||
    scannedThrough < previousUid ||
    (listing.data.hasMore && scannedThrough === previousUid)
  )
    throw new TriggerError('INVALID_POLL_RESULT');
  const seen = new Set<number>();
  const candidates: TriggerCandidate[] = [];
  for (const message of messages) {
    if (message.uid <= previousUid || seen.has(message.uid)) continue;
    seen.add(message.uid);
    const sourceId = JSON.stringify([config.mailbox, listing.data.uidValidity, message.uid]);
    candidates.push({
      triggerId,
      kind: 'imap',
      dedupeKey: triggerEventKey(triggerId, 'imap', sourceId),
      occurredAt: message.receivedAt,
      untrusted: true,
      payload: { ...message, mailbox: config.mailbox, uidValidity: listing.data.uidValidity },
    });
  }
  return {
    candidates,
    nextCursor: { uidValidity: listing.data.uidValidity, lastUid: scannedThrough },
    hasMore: listing.data.hasMore,
    nextPollAt: new Date(
      now.getTime() + (listing.data.hasMore ? 1 : config.pollIntervalSeconds) * 1000,
    ).toISOString(),
  };
}

/** Persist failure count and returned deadline; process restarts must not reset backoff. */
export function pollBackoff(input: {
  baseIntervalSeconds: number;
  consecutiveFailures: number;
  now: Date;
}): { delaySeconds: number; nextPollAt: string } {
  const parsed = z
    .strictObject({
      baseIntervalSeconds: pollIntervalSchema,
      consecutiveFailures: z.number().int().min(0).max(100_000),
      now: z.date(),
    })
    .safeParse(input);
  if (!parsed.success) throw new TriggerError('INVALID_TRIGGER');
  const delaySeconds = Math.min(
    86_400,
    parsed.data.baseIntervalSeconds * 2 ** Math.min(parsed.data.consecutiveFailures, 16),
  );
  return {
    delaySeconds,
    nextPollAt: new Date(parsed.data.now.getTime() + delaySeconds * 1000).toISOString(),
  };
}
