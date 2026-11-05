import { createECDH, randomBytes } from 'node:crypto';
import webPush from 'web-push';
import { describe, expect, it, vi } from 'vitest';
import { createWebPushSender, validatePushSubscription } from './push.js';

function subscription(endpoint = 'https://fcm.googleapis.com/fcm/send/device-fixture') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}
describe('official browser push transport', () => {
  it('rejects SSRF destinations, credentials in URLs and malformed encryption keys', () => {
    for (const url of [
      'http://fcm.googleapis.com/push',
      'https://127.0.0.1/push',
      'https://fcm.googleapis.com.evil.test/push',
      'https://secret@fcm.googleapis.com/push',
      'https://fcm.googleapis.com:444/push',
      'https://metadata.google.internal/push',
    ])
      expect(() => validatePushSubscription(subscription(url))).toThrow();
    expect(() =>
      validatePushSubscription({
        ...subscription(),
        keys: { p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) },
      }),
    ).toThrow();
    expect(() => validatePushSubscription({ ...subscription(), expirationTime: 1 })).toThrow();
    expect(validatePushSubscription(subscription()).endpoint).toContain('fcm.googleapis.com');
  });
  it('sends only generic notices with zero queue TTL and marks expired or uncertain failures', async () => {
    const send = vi
      .spyOn(webPush, 'sendNotification')
      .mockResolvedValue({ statusCode: 201, headers: {}, body: '' });
    const keys = webPush.generateVAPIDKeys();
    const sender = createWebPushSender({
      publicKey: keys.publicKey,
      privateKey: () => Promise.resolve(keys.privateKey),
      subject: () => Promise.resolve('mailto:owner@example.test'),
    });
    await sender(subscription(), 'activity', 'notification:fixture');
    expect(send.mock.calls[0]?.[1]).toBe('{"version":1,"kind":"activity"}');
    expect(send.mock.calls[0]?.[2]).toMatchObject({ TTL: 0, timeout: 5000 });
    send.mockRejectedValueOnce({ statusCode: 410, body: 'private-service-error' });
    await expect(sender(subscription(), 'digest', 'digest:fixture')).rejects.toMatchObject({
      expired: true,
      message: 'The browser notification was not confirmed.',
    });
    send.mockRejectedValueOnce({ statusCode: 500, body: 'private-service-error' });
    await expect(sender(subscription(), 'digest', 'digest:fixture')).rejects.toMatchObject({
      expired: false,
    });
  });
});
