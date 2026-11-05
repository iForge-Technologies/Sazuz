import { describe, expect, it, vi } from 'vitest';
import { forwardWebhook } from './webhook-proxy';

const triggerId = `trg_${'0'.repeat(26)}`;
describe('public webhook proxy', () => {
  it('preserves exact signed bytes and authentication headers while discarding cookies and URL secrets', async () => {
    const body = new Uint8Array([0, 255, 13, 10, 123, 34, 195, 169, 34, 125]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const request = new Request(`http://localhost/hooks/${triggerId}?ignored=canary`, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/octet-stream',
        cookie: 'private-cookie',
        authorization: 'private-token',
        'x-sazuz-timestamp': '123',
        'x-sazuz-delivery': 'delivery-1',
        'x-sazuz-signature': 'signature',
      },
    });
    const response = await forwardWebhook(request, triggerId, 'http://server:7778', fetcher);
    expect(response.status).toBe(200);
    const [url, options] = fetcher.mock.calls[0] ?? [];
    expect(url).toEqual(new URL(`http://server:7778/hooks/${triggerId}`));
    expect(options?.body).toEqual(body);
    const forwarded = new Headers(options?.headers);
    expect(forwarded.get('x-sazuz-delivery')).toBe('delivery-1');
    expect(forwarded.get('x-sazuz-signature')).toBe('signature');
    expect(forwarded.get('cookie')).toBeNull();
    expect(forwarded.get('authorization')).toBeNull();
  });
  it('rejects oversized and invalid deliveries before contacting the server', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await forwardWebhook(
      new Request('http://localhost', { method: 'POST', body: new Uint8Array(256 * 1024 + 1) }),
      triggerId,
      'http://server:7778',
      fetcher,
    );
    expect(response.status).toBe(413);
    expect(
      (
        await forwardWebhook(
          new Request('http://localhost'),
          '../admin',
          'http://server:7778',
          fetcher,
        )
      ).status,
    ).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
