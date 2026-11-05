import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { secretRefSchema } from '@sazuz/config/settings';
import { z } from 'zod';
import { triggerIdSchema } from './contracts.js';
import { TriggerError } from './errors.js';
import { triggerEventKey } from './events.js';

export const WEBHOOK_MAX_BYTES = 262_144;
export const WEBHOOK_MAX_AGE_SECONDS = 300;
export const WEBHOOK_FUTURE_SKEW_SECONDS = 30;
export const webhookHeaderNames = {
  timestamp: 'x-sazuz-timestamp',
  delivery: 'x-sazuz-delivery',
  signature: 'x-sazuz-signature',
} as const;

export interface WebhookRequest {
  triggerId: string;
  secretRef: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: Uint8Array;
  now: Date;
}
export interface WebhookDependencies {
  withSecret: <T>(reference: string, consume: (secret: string) => Promise<T>) => Promise<T>;
}
export const verifiedWebhookSchema = z.strictObject({
  triggerId: triggerIdSchema,
  deliveryId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/),
  dedupeKey: z.string().regex(/^[a-f0-9]{64}$/),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  timestamp: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type VerifiedWebhook = z.infer<typeof verifiedWebhookSchema>;

const requestSchema = z.strictObject({
  triggerId: triggerIdSchema,
  secretRef: secretRefSchema,
  headers: z.record(z.string().max(256), z.union([z.string(), z.array(z.string())]).optional()),
  body: z.instanceof(Uint8Array),
  now: z.date(),
});
const authenticationSchema = z.strictObject({
  timestamp: z.string().regex(/^(?:0|[1-9]\d{0,10})$/),
  delivery: verifiedWebhookSchema.shape.deliveryId,
  signature: z.string().regex(/^v1=[a-f0-9]{64}$/),
});

function authenticationHeaders(headers: WebhookRequest['headers']) {
  const selected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    const field = Object.entries(webhookHeaderNames).find(([, header]) => header === name)?.[0];
    if (field === undefined) continue;
    if (field in selected || typeof value !== 'string') throw new TriggerError('INVALID_WEBHOOK');
    selected[field] = value;
  }
  const parsed = authenticationSchema.safeParse(selected);
  if (!parsed.success) throw new TriggerError('INVALID_WEBHOOK');
  return parsed.data;
}

/** Authentication only. Persist deliveryId with mission/outbox insertion before acknowledging. */
export async function verifyWebhook(
  input: WebhookRequest,
  dependencies: WebhookDependencies,
): Promise<VerifiedWebhook> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new TriggerError('INVALID_WEBHOOK');
  if (parsed.data.body.byteLength > WEBHOOK_MAX_BYTES) throw new TriggerError('WEBHOOK_TOO_LARGE');
  const headers = authenticationHeaders(parsed.data.headers);
  const timestamp = Number(headers.timestamp);
  const age = parsed.data.now.getTime() / 1000 - timestamp;
  if (age > WEBHOOK_MAX_AGE_SECONDS || age < -WEBHOOK_FUTURE_SKEW_SECONDS)
    throw new TriggerError('WEBHOOK_EXPIRED');

  // Snapshot exact bytes before the asynchronous vault callback; never parse or reserialize JSON.
  const body = Buffer.from(parsed.data.body);
  const prefix = `sazuz.webhook.v1\n${parsed.data.triggerId}\n${headers.timestamp}\n${headers.delivery}\n`;
  let authenticated: boolean;
  try {
    authenticated = await dependencies.withSecret(parsed.data.secretRef, (secret) => {
      if (
        typeof secret !== 'string' ||
        Buffer.byteLength(secret) < 32 ||
        Buffer.byteLength(secret) > 4096
      )
        throw new TriggerError('WEBHOOK_SECRET_UNAVAILABLE');
      const key = Buffer.from(secret, 'utf8');
      try {
        const expected = createHmac('sha256', key).update(prefix, 'utf8').update(body).digest();
        const supplied = Buffer.from(headers.signature.slice(3), 'hex');
        return Promise.resolve(timingSafeEqual(expected, supplied));
      } finally {
        key.fill(0);
      }
    });
  } catch {
    throw new TriggerError('WEBHOOK_SECRET_UNAVAILABLE');
  }
  if (authenticated !== true) throw new TriggerError('INVALID_WEBHOOK');
  return verifiedWebhookSchema.parse({
    triggerId: parsed.data.triggerId,
    deliveryId: headers.delivery,
    dedupeKey: triggerEventKey(parsed.data.triggerId, 'webhook', headers.delivery),
    bodySha256: createHash('sha256').update(body).digest('hex'),
    timestamp: new Date(timestamp * 1000).toISOString(),
    expiresAt: new Date((timestamp + WEBHOOK_MAX_AGE_SECONDS) * 1000).toISOString(),
  });
}

export interface WebhookReceiptRepository {
  /** Atomically persist nonce and event/mission outbox; false only for a previously claimed nonce. */
  claimDelivery: (receipt: VerifiedWebhook) => Promise<boolean>;
}

export async function acceptWebhook(
  input: WebhookRequest,
  dependencies: WebhookDependencies & WebhookReceiptRepository,
): Promise<VerifiedWebhook> {
  const receipt = await verifyWebhook(input, dependencies);
  let claimed: boolean;
  try {
    claimed = await dependencies.claimDelivery(receipt);
  } catch {
    throw new TriggerError('WEBHOOK_RECEIPT_FAILED');
  }
  if (claimed !== true) throw new TriggerError('WEBHOOK_REPLAYED');
  return receipt;
}
