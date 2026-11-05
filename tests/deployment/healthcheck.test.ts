import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

interface HealthcheckModule {
  checkHealth: (port: number) => Promise<boolean>;
}

const moduleUrl = new URL('../../deploy/healthcheck.mjs', import.meta.url);
const { checkHealth } = (await import(moduleUrl.href)) as HealthcheckModule;
const canary = 'canary-probe-credential-never-print';
const ready = {
  status: 'ok',
  services: { database: { status: 'ok' }, worker: { status: 'ok', activeCount: 1 } },
};
const servers = new Set<Server>();

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.add(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('A TCP listener was not created.');
  return { server, port: address.port };
}

async function close(server: Server) {
  if (!servers.delete(server)) return;
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}

afterEach(async () => {
  await Promise.all([...servers].map(close));
});

describe('production health probe', () => {
  it('requests the health route and accepts a ready database and worker', async () => {
    let requestedPath: string | undefined;
    let accept: string | undefined;
    const { port } = await listen((request, response) => {
      requestedPath = request.url;
      accept = request.headers.accept;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(ready));
    });
    await expect(checkHealth(port)).resolves.toBe(true);
    expect(requestedPath).toBe('/api/health');
    expect(accept).toBe('application/json');
  });

  it.each([
    { name: 'an unavailable service', status: 503, body: ready },
    {
      name: 'a failed database',
      status: 200,
      body: { ...ready, services: { ...ready.services, database: { status: 'error' } } },
    },
    {
      name: 'a missing worker',
      status: 200,
      body: {
        ...ready,
        services: { ...ready.services, worker: { status: 'missing', activeCount: 0 } },
      },
    },
    {
      name: 'an inconsistent active worker count',
      status: 200,
      body: { ...ready, services: { ...ready.services, worker: { status: 'ok', activeCount: 0 } } },
    },
    { name: 'an invalid response shape', status: 200, body: { status: 'ok' } },
  ])('rejects $name', async ({ status, body }) => {
    const { port } = await listen((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await expect(checkHealth(port)).resolves.toBe(false);
  });

  it('rejects malformed responses without emitting their contents', async () => {
    const stderr = vi.spyOn(process.stderr, 'write');
    const stdout = vi.spyOn(process.stdout, 'write');
    const { port } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(canary);
    });
    await expect(checkHealth(port)).resolves.toBe(false);
    expect(stderr.mock.calls.flat().join('')).not.toContain(canary);
    expect(stdout.mock.calls.flat().join('')).not.toContain(canary);
  });

  it('does not follow a redirect to a healthy endpoint', async () => {
    let destinationRequests = 0;
    const destination = await listen((_request, response) => {
      destinationRequests += 1;
      response.end(JSON.stringify(ready));
    });
    const { port } = await listen((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${destination.port}/api/health` });
      response.end();
    });
    await expect(checkHealth(port)).resolves.toBe(false);
    expect(destinationRequests).toBe(0);
  });

  it('reports a refused connection as not ready', async () => {
    const { server, port } = await listen((_request, response) => response.end());
    await close(server);
    await expect(checkHealth(port)).resolves.toBe(false);
  });

  it('reports a dropped response as not ready', async () => {
    const { port } = await listen((_request, response) => response.destroy());
    await expect(checkHealth(port)).resolves.toBe(false);
  });

  it('bounds a request when the dependency never responds', async () => {
    const { port } = await listen(() => undefined);
    await expect(checkHealth(port)).resolves.toBe(false);
  }, 7_000);

  it('rejects invalid ports before making a request', async () => {
    await expect(checkHealth(0)).resolves.toBe(false);
    await expect(checkHealth(65_536)).resolves.toBe(false);
    await expect(checkHealth(Number.NaN)).resolves.toBe(false);
  });

  it('rejects invalid CLI roles without echoing arguments', async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>(
      (resolveResult, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(moduleUrl), canary], {
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
          timeout: 4_000,
        });
        let stderr = '';
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.once('error', reject);
        child.once('close', (code) => resolveResult({ code, stderr }));
      },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('Sazuz health check failed.\n');
  });
});
