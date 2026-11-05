import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePublicUrl } from '@sazuz/tools';
import { createEgressProxy } from './egress.js';
import { issueGrant } from './auth.js';

const key = Buffer.alloc(32, 8).toString('base64url');
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port.');
  return address.port;
}
async function setup() {
  const observed: unknown[] = [];
  const target = createServer((incoming, response) => {
    observed.push(incoming.headers);
    response.end('fixture reached');
  });
  const targetPort = await listen(target);
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        target.closeAllConnections();
        target.close(() => resolve());
      }),
  );
  const proxy = createEgressProxy({
    key,
    resolve: (url, dependencies) =>
      resolvePublicUrl(url, {
        ...dependencies,
        lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      }),
    dial: () => connect({ host: '127.0.0.1', port: targetPort }),
  });
  const port = await listen(proxy.server);
  closers.push(() => proxy.close());
  const token = issueGrant(key, {
    service: 'egress',
    subject: 'test',
    projectId: 'project',
    agentId: 'analyst',
    domains: ['allowed.example.com'],
    expiresAt: Date.now() + 5000,
  });
  async function get(url: string, credential = token) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const call = request(
        {
          host: '127.0.0.1',
          port,
          path: url,
          headers: {
            'proxy-authorization': `Basic ${Buffer.from(`sazuz:${credential}`).toString('base64')}`,
          },
        },
        (response) => {
          let body = '';
          response.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      call.once('error', reject);
      call.end();
    });
  }
  return { observed, get, token, port };
}
describe('real egress listener with pinned fixture transport', () => {
  it('blocks unlisted, private, metadata and forged requests without contacting the destination', async () => {
    const fixture = await setup();
    for (const url of [
      'http://unlisted.example.com/',
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://allowed.example.com:2375/containers/json',
    ])
      expect((await fixture.get(url)).status).toBe(403);
    expect((await fixture.get('http://allowed.example.com/', 'forged')).status).toBe(403);
    expect(fixture.observed).toHaveLength(0);
  });
  it('allows an exact admitted domain and strips proxy credentials', async () => {
    const fixture = await setup();
    expect(await fixture.get('http://allowed.example.com/path')).toEqual({
      status: 200,
      body: 'fixture reached',
    });
    expect(fixture.observed).toHaveLength(1);
    expect(JSON.stringify(fixture.observed)).not.toContain(fixture.token);
    expect(fixture.observed[0]).not.toHaveProperty('proxy-authorization');
  });
  it('pins and restricts CONNECT independently of HTTP requests', async () => {
    const fixture = await setup();
    const status = await new Promise<number>((resolve, reject) => {
      const call = request({
        host: '127.0.0.1',
        port: fixture.port,
        method: 'CONNECT',
        path: 'unlisted.example.com:443',
        headers: {
          'proxy-authorization': `Basic ${Buffer.from(`sazuz:${fixture.token}`).toString('base64')}`,
        },
      });
      call.on('connect', (response, socket) => {
        resolve(response.statusCode ?? 0);
        socket.destroy();
      });
      call.on('error', reject);
      call.end();
    });
    expect(status).toBe(403);
    expect(fixture.observed).toHaveLength(0);
  });
});
