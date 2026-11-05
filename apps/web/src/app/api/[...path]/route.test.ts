import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';
afterEach(() => vi.unstubAllGlobals());
describe('workspace API proxy', () => {
  it.each(['memory', 'kb', 'skills', 'recipes', 'agents'])(
    'forwards authenticated %s routes',
    async (path) => {
      const fetcher = vi.fn().mockResolvedValue(Response.json([]));
      vi.stubGlobal('fetch', fetcher);
      const result = await GET(
        new NextRequest(`http://localhost/api/${path}`, { headers: { cookie: 'session=test' } }),
        { params: Promise.resolve({ path: [path] }) },
      );
      expect(result.status).toBe(200);
      expect(fetcher).toHaveBeenCalledOnce();
      expect((fetcher.mock.calls[0]?.[1] as RequestInit).headers).toBeInstanceOf(Headers);
    },
  );
  it('permits bounded document uploads while retaining ordinary request limits and private route isolation', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal('fetch', fetcher);
    const request = (path: string) =>
      new NextRequest(`http://localhost/api/${path}`, { method: 'POST', body: 'x'.repeat(140000) });
    expect(
      (
        await POST(request('kb/sources/upload'), {
          params: Promise.resolve({ path: ['kb', 'sources', 'upload'] }),
        })
      ).status,
    ).toBe(200);
    expect(
      (await POST(request('memory'), { params: Promise.resolve({ path: ['memory'] }) })).status,
    ).toBe(413);
    expect(
      (
        await POST(request('internal/execution'), {
          params: Promise.resolve({ path: ['internal', 'execution'] }),
        })
      ).status,
    ).toBe(404);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
