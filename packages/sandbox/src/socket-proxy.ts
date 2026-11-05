import { createServer, request as httpRequest } from 'node:http';
import Docker from 'dockerode';
import { z } from 'zod';
import type { InfraConfig } from '@sazuz/config';
import { SandboxError } from '@sazuz/core/sandbox';
import { containerNameSchema, validateContainer } from './container.js';
import { mcpContainerNameSchema, validateMcpContainer } from './mcp-container.js';
import { verifyGrant } from './auth.js';
import { closeHttp, readBounded, rejectRequest } from './http.js';

const dockerState = z.object({
  Name: z.string(),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
  State: z.object({ Running: z.boolean() }),
});
export function createDockerSocketProxy(options: {
  key: string;
  config: InfraConfig;
  socketPath?: string;
  onError: (code: string) => void;
}) {
  const socketPath = options.socketPath ?? '/var/run/docker.sock';
  const docker = new Docker({ socketPath, timeout: 10_000 });
  const managedName = (name: unknown) =>
    containerNameSchema.safeParse(name).success || mcpContainerNameSchema.safeParse(name).success;
  async function inspect(name: string) {
    const state = dockerState.parse(await docker.getContainer(name).inspect());
    if (
      state.Name !== `/${name}` ||
      state.Config.Labels?.['sazuz.managed'] !== (name.startsWith('sazuz-mcp-') ? 'mcp' : 'code')
    )
      throw new SandboxError('SANDBOX_DENIED');
    return state;
  }
  const server = createServer(
    { requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 24_576 },
    (request, response) => {
      void (async () => {
        const grant = verifyGrant(options.key, 'docker', request.headers['x-sazuz-capability']);
        const url = new URL(request.url ?? '', 'http://socket-proxy');
        const path = url.pathname.replace(/^\/v1\.47(?=\/)/, '');
        const body = await readBounded(request);
        if (
          path === '/_ping' &&
          request.method === 'GET' &&
          grant.subject === 'health' &&
          !url.search &&
          body.length === 0
        ) {
          await docker.ping();
          response.end('OK');
          return;
        }
        if (path === '/containers/create' && request.method === 'POST') {
          if ([...url.searchParams.keys()].some((key) => key !== 'name'))
            throw new SandboxError('SANDBOX_DENIED');
          let value: unknown;
          try {
            value = JSON.parse(body.toString('utf8'));
          } catch {
            throw new SandboxError('SANDBOX_INVALID');
          }
          const name = url.searchParams.get('name') ?? '';
          if (name.startsWith('sazuz-mcp-')) {
            validateMcpContainer(value, name, grant);
          } else {
            const spec = validateContainer(value, name, grant, options.config);
            if (spec.HostConfig.Mounts[1]) {
              const item = spec.Env.find((entry) => entry.startsWith('HTTPS_PROXY='))!;
              const proxyGrant = verifyGrant(
                options.key,
                'egress',
                decodeURIComponent(new URL(item.slice(12)).password),
              );
              if (
                proxyGrant.subject !== grant.subject ||
                proxyGrant.projectId !== grant.projectId ||
                proxyGrant.agentId !== grant.agentId ||
                JSON.stringify(proxyGrant.domains) !== JSON.stringify(grant.domains) ||
                proxyGrant.expiresAt > grant.expiresAt
              )
                throw new SandboxError('SANDBOX_DENIED');
            }
          }
        } else {
          const match =
            /^\/containers\/(sazuz-(?:code|mcp)-[a-f0-9]{40})(?:\/(json|logs|start|kill))?$/.exec(
              path,
            );
          if (!match || !managedName(match[1]) || match[1] !== grant.subject || body.length !== 0)
            throw new SandboxError('SANDBOX_DENIED');
          const action = match[2] ?? 'remove';
          const method = ['json', 'logs'].includes(action)
            ? 'GET'
            : action === 'remove'
              ? 'DELETE'
              : 'POST';
          if (request.method !== method) throw new SandboxError('SANDBOX_DENIED');
          const allowed: Record<string, readonly string[]> =
            action === 'logs'
              ? {
                  stdout: ['true', '1'],
                  stderr: ['true', '1'],
                  follow: ['false', '0'],
                  tail: ['1000'],
                }
              : action === 'remove'
                ? { force: ['false', '0'], v: ['false', '0'] }
                : action === 'kill'
                  ? { signal: ['SIGKILL', '9'] }
                  : {};
          for (const [key, value] of url.searchParams)
            if (!allowed[key]?.includes(value)) throw new SandboxError('SANDBOX_DENIED');
          try {
            const state = await inspect(match[1]);
            if (
              state.Config.Labels?.['sazuz.project'] !== grant.projectId ||
              (action === 'start' && Number(state.Config.Labels['sazuz.expires']) <= Date.now())
            )
              throw new SandboxError('SANDBOX_DENIED');
          } catch (error) {
            if (
              typeof error === 'object' &&
              error !== null &&
              'statusCode' in error &&
              error.statusCode === 404
            ) {
              response.writeHead(404, { 'content-type': 'application/json' });
              response.end('{"message":"Container unavailable."}');
              return;
            }
            throw error;
          }
        }
        const upstream = httpRequest({
          socketPath,
          path: `/v1.47${path}${url.search}`,
          method: request.method,
          headers: { 'content-type': 'application/json', 'content-length': body.length },
          timeout: 10_000,
        });
        upstream.once('timeout', () => upstream.destroy());
        upstream.once('error', () => rejectRequest(response, 503));
        response.once('close', () => upstream.destroy());
        upstream.once('response', (incoming) => {
          void (async () => {
            const bytes = await readBounded(incoming, 2_097_152);
            // Daemon errors can contain paths, environment values and submitted code.
            if ((incoming.statusCode ?? 500) >= 400) {
              rejectRequest(response, incoming.statusCode);
              return;
            }
            response.writeHead(incoming.statusCode ?? 502, {
              'content-type': incoming.headers['content-type'] ?? 'application/json',
            });
            response.end(bytes);
          })().catch(() => {
            incoming.destroy();
            rejectRequest(response, 502);
          });
        });
        upstream.end(body);
      })().catch(() => rejectRequest(response));
    },
  );
  // Docker's attach protocol is the only admitted duplex route. No exec/build/pull or raw socket forwarding.
  server.on('upgrade', (request, downstream, head) => {
    void (async () => {
      const grant = verifyGrant(options.key, 'docker', request.headers['x-sazuz-capability']);
      const url = new URL(request.url ?? '', 'http://socket-proxy');
      const match = /^\/(?:v1\.47\/)?containers\/(sazuz-mcp-[a-f0-9]{40})\/attach$/.exec(
        url.pathname,
      );
      if (
        !match ||
        request.method !== 'POST' ||
        head.length ||
        grant.subject !== match[1] ||
        !grant.specHash ||
        (request.headers['content-length'] && request.headers['content-length'] !== '0') ||
        request.headers['transfer-encoding'] ||
        url.searchParams.size !== 4 ||
        ['stdin', 'stdout', 'stderr', 'stream'].some(
          (key) => !['1', 'true'].includes(url.searchParams.get(key) ?? ''),
        )
      )
        throw new SandboxError('SANDBOX_DENIED');
      const state = await inspect(match[1]);
      if (
        state.Config.Labels?.['sazuz.project'] !== grant.projectId ||
        Number(state.Config.Labels['sazuz.expires']) <= Date.now()
      )
        throw new SandboxError('SANDBOX_DENIED');
      const upstream = httpRequest({
        socketPath,
        method: 'POST',
        path: `/v1.47/containers/${match[1]}/attach${url.search}`,
        headers: { connection: 'Upgrade', upgrade: 'tcp', 'content-length': '0' },
        timeout: 10_000,
      });
      upstream.once('timeout', () => upstream.destroy());
      upstream.once('error', () => downstream.destroy());
      upstream.once('response', () => {
        upstream.destroy();
        downstream.destroy();
      });
      downstream.once('close', () => upstream.destroy());
      upstream.once('upgrade', (_response, socket, initial) => {
        let bytes = 0;
        const timer = setTimeout(
          () => {
            socket.destroy();
            downstream.destroy();
          },
          Math.max(1, grant.expiresAt - Date.now()),
        );
        const count = (data: Buffer) => {
          bytes += data.length;
          if (bytes > 2_097_152) {
            socket.destroy();
            downstream.destroy();
          }
        };
        socket.on('data', count);
        downstream.on('data', count);
        socket.on('error', () => downstream.destroy());
        downstream.on('error', () => socket.destroy());
        socket.once('close', () => {
          clearTimeout(timer);
          downstream.destroy();
        });
        downstream.once('close', () => {
          clearTimeout(timer);
          socket.destroy();
        });
        downstream.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
        if (initial.length) downstream.write(initial);
        socket.pipe(downstream);
        downstream.pipe(socket);
      });
      upstream.end();
    })().catch(() => {
      options.onError('MCP_ATTACH_DENIED');
      downstream.destroy();
    });
  });
  let busy = false;
  async function reap() {
    if (busy) return;
    busy = true;
    try {
      const containers = await docker.listContainers({
        all: true,
        filters: JSON.stringify({ label: ['sazuz.managed'] }),
      });
      for (const container of containers) {
        const name = container.Names[0]?.replace(/^\//, '');
        if (!managedName(name)) continue;
        const state = await inspect(name!);
        const expiresAt = Number(state.Config.Labels?.['sazuz.expires']);
        if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) continue;
        if (state.State.Running) await docker.getContainer(name!).kill();
        else if (Date.now() - expiresAt > 86_400_000)
          await docker.getContainer(name!).remove({ force: false, v: false });
      }
    } catch {
      options.onError('SANDBOX_DEADLINE_RECONCILIATION_FAILED');
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => {
    void reap();
  }, 1000);
  timer.unref();
  server.on('clientError', (_error, socket) => socket.destroy());
  return {
    server,
    reap,
    async close() {
      clearInterval(timer);
      await closeHttp(server);
    },
  };
}
