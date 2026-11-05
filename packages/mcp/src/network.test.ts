import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  proxy: vi.fn(),
  close: vi.fn(() => Promise.resolve()),
}));
vi.mock('undici', () => ({
  fetch: mocks.request,
  ProxyAgent: class {
    constructor(value: unknown) {
      mocks.proxy(value);
    }
    destroy() {
      return mocks.close();
    }
  },
}));
import { mcpHttpFetch } from './network.js';

afterEach(() => {
  vi.clearAllMocks();
});
function connection() {
  return mcpHttpFetch({
    endpoint: 'https://mcp.example.com/mcp',
    projectId: 'project',
    agentId: 'operator',
    key: Buffer.alloc(32, 22).toString('base64url'),
    token: 'mcp-network-secret-canary-1299874',
    config: { egressProxyUrl: 'http://egress-proxy:8080' },
    signal: AbortSignal.timeout(1000),
  });
}
it('uses the authenticated proxy, binds credentials to the exact endpoint and disables redirects', async () => {
  mocks.request.mockResolvedValue(Response.json({ ready: true }));
  const client = connection();
  expect(
    await (
      await client.fetch('https://mcp.example.com/mcp', {
        method: 'POST',
        headers: { authorization: 'foreign', cookie: 'foreign-cookie' },
        body: '{}',
      })
    ).json(),
  ).toEqual({ ready: true });
  const proxyToken: unknown = expect.stringMatching(/^Basic /);
  expect(mocks.proxy).toHaveBeenCalledWith(
    expect.objectContaining({
      uri: 'http://egress-proxy:8080',
      token: proxyToken,
    }),
  );
  expect(mocks.request).toHaveBeenCalledWith(
    new URL('https://mcp.example.com/mcp'),
    expect.objectContaining({
      redirect: 'error',
      headers: { authorization: 'Bearer mcp-network-secret-canary-1299874' },
    }),
  );
  await expect(client.fetch('https://foreign.example/mcp')).rejects.toThrow();
  await expect(client.fetch('https://mcp.example.com/other')).rejects.toThrow();
  await expect(client.fetch('https://mcp.example.com/mcp', { method: 'PUT' })).rejects.toThrow();
  await expect(
    client.fetch('https://mcp.example.com/mcp', { method: 'POST', body: 'a'.repeat(131073) }),
  ).rejects.toThrow();
  expect(mocks.request).toHaveBeenCalledTimes(1);
  await client.close();
  expect(mocks.close).toHaveBeenCalledOnce();
});
it('stops oversized response streams before the MCP parser can consume them', async () => {
  mocks.request.mockResolvedValue(new Response(new Uint8Array(524289)));
  const client = connection();
  const response = await client.fetch('https://mcp.example.com/mcp');
  await expect(response.text()).rejects.toThrow();
  await client.close();
});
