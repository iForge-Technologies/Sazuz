import { expect, it, vi } from 'vitest';
import { forwardChannelWebhook } from './channel-webhook-proxy';

it('forwards exact signed bytes and the official verification query without cookies', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('challenge'));
  const body = '{ "text": "signed bytes" }';
  await forwardChannelWebhook(
    new Request('https://sazuz.example/channels/hooks/slack', {
      method: 'POST',
      headers: { 'x-slack-signature': 'v0=fixture', cookie: 'private-session' },
      body,
    }),
    'slack',
    'http://127.0.0.1:7778',
    fetcher,
  );
  const init = fetcher.mock.calls[0]![1]!;
  expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(body);
  expect(new Headers(init.headers).get('cookie')).toBeNull();
  expect(new Headers(init.headers).get('x-slack-signature')).toBe('v0=fixture');
  await forwardChannelWebhook(
    new Request('https://sazuz.example/channels/hooks/cloud?hub.challenge=hello'),
    'cloud',
    'http://127.0.0.1:7778',
    fetcher,
  );
  const target = fetcher.mock.calls[1]![0];
  expect(target instanceof URL && target.search).toContain('hub.challenge=hello');
});

it('bounds undeclared request bodies before forwarding', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const response = await forwardChannelWebhook(
    new Request('https://sazuz.example/channels/hooks/slack', {
      method: 'POST',
      body: 'x'.repeat(131_073),
    }),
    'slack',
    'http://127.0.0.1:7778',
    fetcher,
  );
  expect(response.status).toBe(413);
  expect(fetcher).not.toHaveBeenCalled();
});
