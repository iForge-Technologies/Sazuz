import { z } from 'zod';
import { workId } from './work';

// Browser-owned gateways only. A subscription cannot turn the server into a general HTTP client.
export const pushEndpointSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      ([
        'fcm.googleapis.com',
        'updates.push.services.mozilla.com',
        'push.services.mozilla.com',
        'web.push.apple.com',
      ].includes(url.hostname) ||
        /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname))
    );
  });
export const pushSubscriptionSchema = z.strictObject({
  endpoint: pushEndpointSchema,
  expirationTime: z.number().finite().nonnegative().nullable().optional(),
  keys: z.strictObject({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  }),
});
export const pushEnrollSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  subscription: pushSubscriptionSchema,
  consent: z.literal(true),
});
export const pushDeviceSchema = z.strictObject({
  id: workId,
  name: z.string().max(80),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export const pushStatusSchema = z.strictObject({
  enabled: z.boolean(),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  devices: z.array(pushDeviceSchema).max(20),
  deliveries: z
    .array(
      z.strictObject({
        id: workId,
        deviceId: workId,
        status: z.enum(['intent', 'done', 'uncertain', 'skipped']),
        createdAt: z.iso.datetime(),
      }),
    )
    .max(30),
});
export class PushError extends Error {
  constructor(
    readonly code:
      'PUSH_INVALID' | 'PUSH_DISABLED' | 'PUSH_NOT_FOUND' | 'PUSH_DENIED' | 'PUSH_LIMIT',
  ) {
    super(
      {
        PUSH_INVALID: 'This browser push subscription is invalid or unsupported.',
        PUSH_DISABLED: 'Enable Web Push in Channels settings before enrolling this browser.',
        PUSH_NOT_FOUND: 'This browser subscription is unavailable.',
        PUSH_DENIED: 'Current policy does not permit this notification action.',
        PUSH_LIMIT: 'Revoke an old device before enrolling another browser.',
      }[code],
    );
    this.name = 'PushError';
  }
}
