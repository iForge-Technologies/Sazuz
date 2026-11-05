import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  acceptWebhook,
  verifyWebhook,
  WEBHOOK_MAX_BYTES,
  type WebhookDependencies,
  type WebhookRequest,
} from './webhooks.js';

const secret = 'fixture-signing-key-at-least-thirty-two-bytes';
const now = new Date('2026-11-03T09:00:00.000Z');
const dependencies: WebhookDependencies = {
  withSecret: (_reference, consume) => consume(secret),
};
function request(overrides: Partial<WebhookRequest> = {}): WebhookRequest {
  const timestamp = String(now.getTime() / 1000);
  const delivery = 'fixture-delivery-0001';
  const body = Buffer.from('{"text":"hello ☀"}\n');
  const signature = createHmac('sha256', secret)
    .update(`sazuz.webhook.v1\ntrg_fixture\n${timestamp}\n${delivery}\n`)
    .update(body)
    .digest('hex');
  return {
    triggerId: 'trg_fixture',
    secretRef: 'secret://sec_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    body,
    headers: {
      'x-sazuz-timestamp': timestamp,
      'x-sazuz-delivery': delivery,
      'x-sazuz-signature': `v1=${signature}`,
    },
    now,
    ...overrides,
  };
}

describe('signed webhook ingress', () => {
  it('verifies exact UTF-8 bytes using only an execution-scoped secret callback', async () => {
    const input = request();
    const receipt = await verifyWebhook(input, dependencies);
    expect(receipt).toMatchObject({
      triggerId: 'trg_fixture',
      deliveryId: 'fixture-delivery-0001',
      timestamp: now.toISOString(),
      expiresAt: '2026-11-03T09:05:00.000Z',
      bodySha256: createHash('sha256').update(input.body).digest('hex'),
    });
    expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(JSON.stringify(receipt)).not.toContain('hello');
  });

  it('rejects whitespace changes, tampering, trigger substitution and nonce substitution', async () => {
    const good = request();
    for (const altered of [
      request({ body: Buffer.from('{ "text": "hello ☀" }\n') }),
      request({ body: Buffer.from('{"text":"different"}') }),
      request({ triggerId: 'trg_other' }),
      request({ headers: { ...good.headers, 'x-sazuz-delivery': 'fixture-delivery-0002' } }),
    ]) {
      await expect(verifyWebhook(altered, dependencies)).rejects.toMatchObject({
        code: 'INVALID_WEBHOOK',
      });
    }
  });

  it('rejects expired, future and noncanonical timestamps before resolving a credential', async () => {
    const accesses = vi.fn();
    const withSecret: WebhookDependencies['withSecret'] = (reference, consume) => {
      accesses(reference);
      return dependencies.withSecret(reference, consume);
    };
    await expect(
      verifyWebhook(request({ now: new Date(now.getTime() + 300_001) }), { withSecret }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_EXPIRED' });
    await expect(
      verifyWebhook(request({ now: new Date(now.getTime() - 30_001) }), { withSecret }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_EXPIRED' });
    const original = request();
    await expect(
      verifyWebhook(
        request({
          headers: { ...original.headers, 'x-sazuz-timestamp': `0${String(now.getTime() / 1000)}` },
        }),
        { withSecret },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_WEBHOOK' });
    expect(accesses).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies, duplicate headers and malformed signatures', async () => {
    const accesses = vi.fn();
    const withSecret: WebhookDependencies['withSecret'] = (reference, consume) => {
      accesses(reference);
      return dependencies.withSecret(reference, consume);
    };
    await expect(
      verifyWebhook(request({ body: new Uint8Array(WEBHOOK_MAX_BYTES + 1) }), { withSecret }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_TOO_LARGE' });
    const original = request();
    for (const headers of [
      { ...original.headers, 'X-Sazuz-Signature': original.headers['x-sazuz-signature'] },
      { ...original.headers, 'x-sazuz-signature': ['v1=abc', 'v1=def'] },
      { ...original.headers, 'x-sazuz-signature': 'v1=abc' },
      { ...original.headers, 'x-sazuz-delivery': 'too-short' },
    ]) {
      await expect(verifyWebhook(request({ headers }), { withSecret })).rejects.toMatchObject({
        code: 'INVALID_WEBHOOK',
      });
    }
    expect(accesses).not.toHaveBeenCalled();
  });

  it('supports case-insensitive single headers and snapshots the body before an async credential callback', async () => {
    const original = request();
    const changed = {
      ...original,
      headers: Object.fromEntries(
        Object.entries(original.headers).map(([key, value]) => [key.toUpperCase(), value]),
      ),
    };
    const receipt = await verifyWebhook(changed, {
      withSecret: (_reference, consume) => {
        changed.body.fill(0);
        return consume(secret);
      },
    });
    expect(receipt.bodySha256).toBe(createHash('sha256').update(request().body).digest('hex'));
  });

  it('delegates replay prevention to an atomic receipt repository before accepting', async () => {
    const deliveries = new Set<string>();
    const claimDelivery = vi.fn((receipt: { dedupeKey: string }) => {
      if (deliveries.has(receipt.dedupeKey)) return Promise.resolve(false);
      deliveries.add(receipt.dedupeKey);
      return Promise.resolve(true);
    });
    const repository = { ...dependencies, claimDelivery };
    const outcomes = await Promise.allSettled([
      acceptWebhook(request(), repository),
      acceptWebhook(request(), repository),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'WEBHOOK_REPLAYED' } });
    expect(claimDelivery).toHaveBeenCalledTimes(2);
  });

  it('does not store unauthenticated receipts and redacts credential/storage failures', async () => {
    const claimDelivery = vi.fn(() => Promise.resolve(true));
    await expect(
      acceptWebhook(request({ body: Buffer.from('altered') }), { ...dependencies, claimDelivery }),
    ).rejects.toMatchObject({ code: 'INVALID_WEBHOOK' });
    expect(claimDelivery).not.toHaveBeenCalled();
    await expect(
      verifyWebhook(request(), {
        withSecret: () => Promise.reject(new Error(`credential ${secret}`)),
      }),
    ).rejects.toThrow('The webhook verification credential is unavailable.');
    await expect(
      acceptWebhook(request(), {
        ...dependencies,
        claimDelivery: () => Promise.reject(new Error(`storage ${secret}`)),
      }),
    ).rejects.toThrow('The webhook receipt could not be recorded.');
  });
});
