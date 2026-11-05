import { describe, expect, it, vi } from 'vitest';
import { forwardGoogleCallback } from './oauth-proxy';

describe('Google callback proxy', () => {
  it('forwards the callback with the owner cookie and returns a clean Settings redirect', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: {
          location: '/settings?section=connectors&oauth=connected',
          'set-cookie': 'session=renewed; HttpOnly',
        },
      }),
    );
    const response = await forwardGoogleCallback(
      new Request(
        'https://sazuz.example/oauth/google/callback?code=private-code&state=bound-state&ignored=private-extra',
        { headers: { cookie: 'session=owner', authorization: 'private-token' } },
      ),
      'http://server:7778',
      fetcher,
    );
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toEqual(
      new URL('http://server:7778/oauth/google/callback?code=private-code&state=bound-state'),
    );
    expect(new Headers(init?.headers).get('cookie')).toBe('session=owner');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(init?.redirect).toBe('manual');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/settings?section=connectors&oauth=connected');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });
  it('never reflects upstream errors, authorization codes or redirect destinations', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('sensitive-provider-error', { status: 500 }));
    const response = await forwardGoogleCallback(
      new Request('https://sazuz.example/oauth/google/callback?error=private-error'),
      'http://server:7778',
      fetcher,
    );
    expect(response.headers.get('location')).toBe('/settings?section=connectors&oauth=failed');
    expect(await response.text()).toBe('');
    fetcher.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.example/?code=secret' },
      }),
    );
    expect(
      (
        await forwardGoogleCallback(
          new Request('https://sazuz.example/oauth/google/callback'),
          'http://server:7778',
          fetcher,
        )
      ).headers.get('location'),
    ).toBe('/settings?section=connectors&oauth=failed');
  });
  it('rejects duplicate callback parameters before forwarding', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await forwardGoogleCallback(
      new Request('https://sazuz.example/oauth/google/callback?code=one&code=two'),
      'http://server:7778',
      fetcher,
    );
    expect(response.headers.get('location')).toContain('oauth=failed');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
