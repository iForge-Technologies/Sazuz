import { createHash, ECDH } from 'node:crypto';
import webPush from 'web-push';
import { z } from 'zod';
import { PushError, pushSubscriptionSchema } from '@sazuz/core/push';
import { secretRedactor } from '@sazuz/vault';

export function validatePushSubscription(raw: unknown) {
  const result = pushSubscriptionSchema.safeParse(raw);
  if (!result.success) throw new PushError('PUSH_INVALID');
  const subscription = result.data;
  try {
    const publicKey = Buffer.from(subscription.keys.p256dh, 'base64url');
    const auth = Buffer.from(subscription.keys.auth, 'base64url');
    if (
      publicKey.length !== 65 ||
      auth.length !== 16 ||
      publicKey[0] !== 4 ||
      publicKey.toString('base64url') !== subscription.keys.p256dh ||
      auth.toString('base64url') !== subscription.keys.auth ||
      (subscription.expirationTime !== null &&
        subscription.expirationTime !== undefined &&
        subscription.expirationTime <= Date.now())
    )
      throw new PushError('PUSH_INVALID');
    ECDH.convertKey(publicKey, 'prime256v1');
  } catch {
    throw new PushError('PUSH_INVALID');
  }
  for (const value of [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth])
    secretRedactor.register(value);
  return subscription;
}
export type PushSender = (
  subscription: z.infer<typeof pushSubscriptionSchema>,
  kind: 'activity' | 'digest',
  eventKey: string,
) => Promise<void>;
export class PushDeliveryError extends Error {
  constructor(readonly expired: boolean) {
    super('The browser notification was not confirmed.');
    this.name = 'PushDeliveryError';
  }
}
export function createWebPushSender(options: {
  publicKey: string;
  privateKey: () => Promise<string>;
  subject: () => Promise<string>;
}): PushSender {
  return async (raw, kind, eventKey) => {
    const subscription = validatePushSubscription(raw);
    const privateKey = z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse(await options.privateKey());
    secretRedactor.register(privateKey);
    try {
      await webPush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        JSON.stringify({ version: 1, kind }),
        {
          vapidDetails: {
            subject: await options.subject(),
            publicKey: options.publicKey,
            privateKey,
          },
          TTL: 0,
          urgency: 'normal',
          timeout: 5000,
          topic: createHash('sha256').update(eventKey).digest('base64url').slice(0, 32),
        },
      );
    } catch (error) {
      const status =
        typeof error === 'object' && error !== null && 'statusCode' in error
          ? error.statusCode
          : null;
      throw new PushDeliveryError(status === 404 || status === 410);
    }
  };
}
