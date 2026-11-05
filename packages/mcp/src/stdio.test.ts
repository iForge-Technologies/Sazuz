import { createServer, type Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { readInfraConfig } from '@sazuz/config';
import { createDockerSocketProxy, mcpContainerSchema, type McpContainer } from '@sazuz/sandbox';
import { containerTransport } from './stdio.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function listen(server: HttpServer, socket?: string) {
  await new Promise<void>((resolve) =>
    socket ? server.listen(socket, resolve) : server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}
it('runs official SDK messages through the validating Docker attach protocol without spawning host code', async () => {
  const key = Buffer.alloc(32, 31).toString('base64url'),
    errors: string[] = [];
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\sazuz-mcp-test-${randomUUID()}`
      : join(tmpdir(), `sazuz-mcp-test-${randomUUID()}.sock`);
  let spec: McpContainer | undefined,
    name = '',
    running = false,
    removed = false,
    attached: Duplex | undefined,
    buffer = '';
  function message(value: unknown) {
    const body = Buffer.from(JSON.stringify(value) + '\n'),
      header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(body.length, 4);
    attached?.write(Buffer.concat([header, body]));
  }
  const daemon = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '', 'http://daemon');
      if (url.pathname.endsWith('/containers/json')) {
        response.end('[]');
        return;
      }
      if (url.pathname.endsWith('/containers/create')) {
        const parts: Buffer[] = [];
        for await (const part of request) parts.push(Buffer.from(part as Uint8Array));
        spec = mcpContainerSchema.parse(JSON.parse(Buffer.concat(parts).toString()) as unknown);
        name = url.searchParams.get('name') ?? '';
        response
          .writeHead(201, { 'content-type': 'application/json' })
          .end(JSON.stringify({ Id: name, Warnings: [] }));
        return;
      }
      if (url.pathname.endsWith('/json')) {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            Name: '/' + name,
            Config: { Labels: spec?.Labels },
            State: { Running: running },
          }),
        );
        return;
      }
      if (url.pathname.endsWith('/start')) {
        running = true;
        response.writeHead(204).end();
        return;
      }
      if (url.pathname.endsWith('/kill')) {
        running = false;
        response.writeHead(204).end();
        return;
      }
      if (request.method === 'DELETE') {
        removed = true;
        attached?.destroy();
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    })().catch(() => {
      errors.push('FIXTURE_DAEMON_ERROR');
      response.writeHead(500).end();
    });
  });
  daemon.on('upgrade', (_request, socket) => {
    attached = socket;
    socket.on('error', () => errors.push('FIXTURE_ATTACH_ERROR'));
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    socket.on('data', (data: Buffer) => {
      buffer += data.toString('utf8');
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const request = z
          .object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() })
          .parse(JSON.parse(line) as unknown);
        if (request.id === undefined) continue;
        const result =
          request.method === 'initialize'
            ? {
                protocolVersion: '2025-06-18',
                serverInfo: { name: 'stdio-fixture', version: '1' },
                capabilities: { tools: {} },
              }
            : request.method === 'tools/list'
              ? { tools: [{ name: 'marker', inputSchema: { type: 'object' } }] }
              : { content: [{ type: 'text', text: 'stdio marker' }] };
        message({ jsonrpc: '2.0', id: request.id, result });
      }
    });
  });
  await listen(daemon, socketPath);
  cleanups.push(async () => {
    attached?.destroy();
    daemon.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      daemon.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const proxy = createDockerSocketProxy({
    key,
    config: readInfraConfig({}),
    socketPath,
    onError: (code) => errors.push(code),
  });
  const port = await listen(proxy.server);
  cleanups.push(() => proxy.close());
  const transport = containerTransport({
    key,
    config: { dockerProxyUrl: `http://127.0.0.1:${port}` },
    transport: {
      kind: 'stdio',
      image: `example/mcp@sha256:${'a'.repeat(64)}`,
      command: '/usr/local/bin/node',
      args: ['/app/server.mjs'],
    },
    projectId: 'prj_01K00000000000000000000000',
    agentId: 'operator',
    signal: AbortSignal.timeout(15_000),
  });
  const client = new Client({ name: 'sazuz-stdio-test', version: '1' }, { capabilities: {} });
  cleanups.push(() => client.close());
  client.onerror = () => errors.push('CLIENT_PROTOCOL_ERROR');
  await client.connect(transport, { timeout: 10000 });
  expect((await client.listTools()).tools[0]!.name).toBe('marker');
  expect((await client.callTool({ name: 'marker', arguments: {} })).content).toEqual([
    { type: 'text', text: 'stdio marker' },
  ]);
  expect(spec?.HostConfig.Mounts).toEqual([]);
  expect(spec?.HostConfig.NetworkMode).toBe('none');
  expect(spec?.User).toBe('1000:1000');
  await client.close();
  expect(removed).toBe(true);
  expect(running).toBe(false);
  expect(errors).toEqual([]);
}, 20000);
