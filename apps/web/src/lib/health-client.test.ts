import type { Health } from '@sazuz/core/health';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchHealth } from './health-client';
import { HealthRequestError } from './health-response';

const healthy: Health = {
  status: 'ok',
  checkedAt: '2026-11-03T12:00:00.000Z',
  services: {
    database: { status: 'ok', latencyMs: 3 },
    worker: { status: 'ok', activeCount: 1, lastSeenAt: '2026-11-03T12:00:00.000Z' },
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('browser health request', () => {
  it('uses the same-origin endpoint and validates the result', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(healthy));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchHealth(new AbortController().signal)).toEqual(healthy);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/health',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }),
    );
  });

  it('turns connection errors into a safe, typed unavailable state', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('secret-canary')));
    await expect(fetchHealth()).rejects.toEqual(new HealthRequestError('unavailable'));
  });

  it('turns malformed responses into a separate invalid-response state', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('invalid-json')));
    await expect(fetchHealth()).rejects.toEqual(new HealthRequestError('invalid-response'));
  });
});
