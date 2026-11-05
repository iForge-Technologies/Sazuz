import type { Health } from '@sazuz/core/health';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { proxyHealth } from './health-proxy';

const healthy: Health = {
  status: 'ok',
  checkedAt: '2026-11-03T12:00:00.000Z',
  services: {
    database: { status: 'ok', latencyMs: 3 },
    worker: { status: 'ok', activeCount: 1, lastSeenAt: '2026-11-03T12:00:00.000Z' },
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('runtime health proxy', () => {
  it('uses zero-config defaults and never caches or follows redirects', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(healthy));
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxyHealth();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(healthy);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:7778/api/health'),
      expect.objectContaining({
        cache: 'no-store',
        redirect: 'error',
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves a degraded service result through HTTP 503', async () => {
    const degraded: Health = {
      ...healthy,
      status: 'degraded',
      services: {
        ...healthy.services,
        worker: { status: 'missing', activeCount: 0, lastSeenAt: null },
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(degraded, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxyHealth('http://server:7778');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(degraded);
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(new URL('http://server:7778/api/health'));
  });

  it.each([
    'ftp://server:7778',
    'http://user:secret-canary@server:7778',
    'http://server:7778/private',
    'http://server:7778?token=secret-canary',
    '',
    42,
  ])('fails closed for an invalid origin without leaking its value', async (origin) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const response = await proxyHealth(origin);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'HEALTH_UNAVAILABLE' } });
  });

  it('sanitizes upstream exceptions, bad JSON, and contradictory health responses', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('connection to secret-canary failed'))
      .mockResolvedValueOnce(new Response('secret-canary'))
      .mockResolvedValueOnce(Response.json(healthy, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await proxyHealth();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: 'HEALTH_UNAVAILABLE' } });
    }
  });

  it('bounds a stalled upstream request with a timeout', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, options) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) {
          reject(new Error('A request deadline is required.'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('Upstream request timed out.')), {
          once: true,
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxyHealth();
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'HEALTH_UNAVAILABLE' } });
  });
});
