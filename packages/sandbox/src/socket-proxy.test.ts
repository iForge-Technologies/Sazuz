import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readInfraConfig } from '@sazuz/config';
import { freshSettings } from '@sazuz/config/settings';
import { buildContainer, containerName } from './container.js';
import { issueGrant } from './auth.js';
import { createDockerSocketProxy } from './socket-proxy.js';
import { dockerEngine } from './docker.js';

const key = Buffer.alloc(32, 11).toString('base64url');
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
async function listen(server: Server, socket?: string) {
  await new Promise<void>((resolve) =>
    socket ? server.listen(socket, resolve) : server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}
describe('validating Docker HTTP gateway and independent deadline recovery', () => {
  it('does not forward unauthorized Docker endpoints or unsafe container options', async () => {
    const config = readInfraConfig({});
    const proxy = createDockerSocketProxy({
      key,
      config,
      socketPath: 'unavailable-test-socket',
      onError: () => undefined,
    });
    const port = await listen(proxy.server);
    closers.push(() => proxy.close());
    const projectId = 'prj_01K00000000000000000000000',
      runId = 'run_01K00000000000000000000000';
    const callKey = `${runId}:1:0`,
      name = containerName(callKey),
      expiresAt = Date.now() + 60000;
    const token = issueGrant(key, {
      service: 'docker',
      subject: name,
      projectId,
      agentId: 'analyst',
      domains: [],
      expiresAt,
    });
    const spec = buildContainer({
      args: { language: 'python', code: 'print(42)', network: 'none' },
      projectId,
      runId,
      key: callKey,
      expiresAt,
      settings: freshSettings().sandbox.value,
      config,
    });
    for (const endpoint of [
      '/v1.47/containers/json',
      '/v1.47/images/json',
      '/v1.47/volumes',
      '/v1.47/exec/abc/start',
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
        headers: { 'x-sazuz-capability': token },
      });
      expect(response.status).toBe(403);
    }
    const response = await fetch(`http://127.0.0.1:${port}/v1.47/containers/create?name=${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sazuz-capability': token },
      body: JSON.stringify({ ...spec, HostConfig: { ...spec.HostConfig, Privileged: true } }),
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('Privileged');
    const scoped = {
      subject: name,
      projectId,
      agentId: 'analyst',
      domains: ['example.com'],
      expiresAt,
    };
    const admitted = issueGrant(key, { ...scoped, service: 'docker' });
    const otherGrant = issueGrant(key, {
      ...scoped,
      service: 'egress',
      domains: ['other.example'],
    });
    const networked = buildContainer({
      args: { language: 'node', code: 'console.log(42)', network: 'allowlist' },
      projectId,
      runId,
      key: callKey,
      expiresAt,
      settings: freshSettings().sandbox.value,
      config,
      proxyToken: otherGrant,
    });
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/v1.47/containers/create?name=${name}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sazuz-capability': admitted },
          body: JSON.stringify(networked),
        })
      ).status,
    ).toBe(403);
  });
  it('serves the dockerode client and kills an expired container found after proxy restart', async () => {
    const socket =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\sazuz-docker-${randomUUID()}`
        : join(tmpdir(), `sazuz-docker-${randomUUID()}.sock`);
    const projectId = 'prj_01K00000000000000000000000',
      runId = 'run_01K00000000000000000000000';
    const callKey = `${runId}:2:0`,
      name = containerName(callKey);
    let running = true,
      kills = 0;
    let created: unknown;
    let createPath = '';
    const labels = {
      'sazuz.managed': 'code',
      'sazuz.project': projectId,
      'sazuz.expires': String(Date.now() - 1000),
    };
    const daemon = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://daemon').pathname.replace(/^\/v[\d.]+/, '');
      response.setHeader('content-type', 'application/json');
      if (path === '/containers/create') {
        createPath = request.url ?? '';
        const parts: Buffer[] = [];
        request.on('data', (part: Buffer) => parts.push(part));
        request.on('end', () => {
          created = JSON.parse(Buffer.concat(parts).toString()) as unknown;
          response.writeHead(201).end(JSON.stringify({ Id: name, Warnings: [] }));
        });
      } else if (path === '/containers/json')
        response.end(JSON.stringify([{ Id: name, Names: [`/${name}`], Labels: labels }]));
      else if (path.endsWith('/json'))
        response.end(
          JSON.stringify({
            Name: `/${name}`,
            Config: { Labels: labels },
            State: {
              Running: running,
              ExitCode: running ? 0 : 137,
              Status: running ? 'running' : 'exited',
            },
          }),
        );
      else if (path.endsWith('/kill')) {
        running = false;
        kills++;
        response.writeHead(204);
        response.end();
      } else {
        response.writeHead(404);
        response.end('{}');
      }
    });
    await listen(daemon, socket);
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          daemon.closeAllConnections();
          daemon.close(() => resolve());
        }),
    );
    const config = readInfraConfig({});
    const codes: string[] = [];
    const proxy = createDockerSocketProxy({
      key,
      config,
      socketPath: socket,
      onError: (code) => codes.push(code),
    });
    const port = await listen(proxy.server);
    closers.push(() => proxy.close());
    const token = issueGrant(key, {
      service: 'docker',
      subject: name,
      projectId,
      agentId: 'analyst',
      domains: [],
      expiresAt: Date.now() + 60000,
    });
    const engine = dockerEngine({ ...config, dockerProxyUrl: `http://127.0.0.1:${port}` }, token);
    const spec = buildContainer({
      args: { language: 'python', code: 'print(42)', network: 'none' },
      projectId,
      runId,
      key: callKey,
      expiresAt: Date.now() + 45000,
      settings: freshSettings().sandbox.value,
      config,
    });
    await engine.create(name, spec);
    expect(createPath).toBe(`/v1.47/containers/create?name=${name}`);
    expect(created).toEqual(spec);
    expect((await engine.inspect(name))?.State.Running).toBe(true);
    await proxy.reap();
    expect(kills).toBe(1);
    expect((await engine.inspect(name))?.State.Running).toBe(false);
    expect(codes).toEqual([]);
  });
});
