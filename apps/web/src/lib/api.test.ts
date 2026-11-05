import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { api, ApiError, okSchema } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('validated same-origin API client', () => {
  it('preserves the conflict status and safe code for stale approval decisions', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { code: 'APPROVAL_STALE', message: 'This preview has changed.' } },
            { status: 409 },
          ),
        ),
    );
    await expect(
      api('approvals/apr_fixture/decision', okSchema, { decision: 'approve' }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'APPROVAL_STALE',
      message: 'This preview has changed.',
    });
  });

  it('sends explicit bodyless DELETE requests with same-origin credentials', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    await api('channels/telegram/bindings/bnd_fixture', z.undefined(), undefined, 'DELETE');
    expect(fetcher).toHaveBeenCalledWith(
      '/api/channels/telegram/bindings/bnd_fixture',
      expect.objectContaining({ method: 'DELETE', credentials: 'same-origin', cache: 'no-store' }),
    );
    const input: unknown = fetcher.mock.calls[0]?.[1];
    expect(input).not.toHaveProperty('body');
  });

  it('withholds malformed response bodies and unvalidated success values', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('secret-canary: private upstream response', { status: 502 }),
        ),
    );
    await expect(api('missions', z.array(z.unknown()))).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
      message: 'The server returned an invalid response.',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ secret: 'canary' })));
    await expect(api('control', okSchema)).rejects.toBeInstanceOf(ApiError);
  });

  it('forwards cancellation without exposing raw transport errors', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn().mockRejectedValue(new Error('private transport details'));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      api('missions', z.array(z.unknown()), undefined, 'GET', { signal: controller.signal }),
    ).rejects.toMatchObject({ status: 0, code: 'ABORTED' });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/missions',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
