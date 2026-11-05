import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type IncomingHttpHeaders,
} from 'node:http';
import { connect, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { resolvePublicUrl, type ResolvedAddress } from '@sazuz/tools';
import { SandboxError } from '@sazuz/core/sandbox';
import { verifyGrant, type ServiceGrant } from './auth.js';
import { closeHttp, rejectRequest } from './http.js';

export interface EgressOptions {
  key: string;
  dial?: (address: ResolvedAddress, port: number) => Socket;
  resolve?: typeof resolvePublicUrl;
  now?: () => number;
}
/** The listener has no administrative HTTP routes and never forwards proxy credentials. */
export function createEgressProxy(options: EgressOptions) {
  const now = options.now ?? Date.now;
  const usage = new Map<string, { expires: number; bytes: number; active: number }>();
  const sockets = new Set<Duplex>();
  const dial =
    options.dial ??
    ((address, port) => connect({ host: address.address, family: address.family, port }));
  function authorize(request: IncomingMessage): ServiceGrant {
    const auth = request.headers['proxy-authorization'];
    if (typeof auth !== 'string' || !auth.startsWith('Basic ') || auth.length > 24000)
      throw new SandboxError('SANDBOX_DENIED');
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    if (!decoded.startsWith('sazuz:')) throw new SandboxError('SANDBOX_DENIED');
    return verifyGrant(options.key, 'egress', decoded.slice(6), now());
  }
  function budget(grant: ServiceGrant) {
    for (const [key, value] of usage)
      if (value.expires <= now() && value.active === 0) usage.delete(key);
    if (!usage.has(grant.nonce) && usage.size >= 2000) throw new SandboxError('SANDBOX_DENIED');
    const entry = usage.get(grant.nonce) ?? { expires: grant.expiresAt, bytes: 0, active: 0 };
    if (entry.active >= 8 || entry.bytes >= 16 * 1024 ** 2)
      throw new SandboxError('SANDBOX_DENIED');
    entry.active++;
    usage.set(grant.nonce, entry);
    let released = false;
    return {
      add(bytes: number) {
        entry.bytes += bytes;
        return entry.bytes <= 16 * 1024 ** 2 && now() < grant.expiresAt;
      },
      release() {
        if (!released) {
          entry.active--;
          released = true;
        }
      },
    };
  }
  async function destination(value: string, grant: ServiceGrant) {
    if (!grant.domains.length) throw new SandboxError('SANDBOX_DENIED');
    return (options.resolve ?? resolvePublicUrl)(value, { allowedHosts: grant.domains });
  }
  const server = createServer(
    { requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 32_768 },
    (request, response) => {
      void (async () => {
        if (request.url === '/health' && request.method === 'GET') {
          const grant = verifyGrant(
            options.key,
            'egress',
            request.headers['x-sazuz-capability'],
            now(),
          );
          if (grant.subject !== 'health') throw new SandboxError('SANDBOX_DENIED');
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"ready":true}');
          return;
        }
        if (!request.headers['proxy-authorization']) {
          response.writeHead(407, {
            'proxy-authenticate': 'Basic realm="Sazuz"',
            'content-length': '0',
          });
          response.end();
          return;
        }
        const grant = authorize(request);
        const { url, address } = await destination(request.url ?? '', grant);
        if (
          url.protocol !== 'http:' ||
          !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(
            request.method ?? '',
          )
        )
          throw new SandboxError('SANDBOX_DENIED');
        const limit = budget(grant);
        const headers: IncomingHttpHeaders = { ...request.headers, host: url.host };
        for (const name of [
          'proxy-authorization',
          'proxy-connection',
          'connection',
          'upgrade',
          'x-sazuz-capability',
        ])
          delete headers[name];
        // Connection can nominate arbitrary hop-by-hop fields; strip those as well.
        for (const name of (request.headers.connection ?? '').split(','))
          if (name.trim()) delete headers[name.trim().toLowerCase()];
        headers.host = url.host;
        const agent = new Agent({ keepAlive: false });
        agent.createConnection = () => dial(address, 80);
        const upstream = httpRequest(url, {
          method: request.method,
          headers,
          agent,
          timeout: 10_000,
        });
        const timer = setTimeout(() => upstream.destroy(), Math.max(1, grant.expiresAt - now()));
        timer.unref();
        const close = () => {
          clearTimeout(timer);
          limit.release();
          agent.destroy();
        };
        response.once('close', () => {
          upstream.destroy();
          close();
        });
        upstream.once('error', () => {
          rejectRequest(response, 502);
          close();
        });
        upstream.once('timeout', () => upstream.destroy());
        request.on('data', (chunk: Buffer) => {
          if (!limit.add(chunk.length)) {
            upstream.destroy();
            rejectRequest(response, 413);
          }
        });
        upstream.once('response', (incoming) => {
          const outgoing = { ...incoming.headers };
          delete outgoing['proxy-authenticate'];
          delete outgoing['proxy-authorization'];
          response.writeHead(incoming.statusCode ?? 502, outgoing);
          incoming.on('data', (chunk: Buffer) => {
            if (!limit.add(chunk.length)) {
              incoming.destroy();
              response.destroy();
            }
          });
          incoming.once('error', () => response.destroy());
          incoming.pipe(response);
        });
        request.pipe(upstream);
      })().catch(() => rejectRequest(response));
    },
  );
  server.on('connect', (request, client, head) => {
    // A peer may disconnect during asynchronous authentication/DNS, before a tunnel exists.
    client.on('error', () => client.destroy());
    if (client instanceof Socket) client.setTimeout(10000, () => client.destroy());
    void (async () => {
      if (!request.headers['proxy-authorization']) {
        client.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Sazuz"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
        return;
      }
      const grant = authorize(request);
      if (!/^[a-z0-9.-]+:443$/.test(request.url ?? '')) throw new SandboxError('SANDBOX_DENIED');
      const { address } = await destination(`https://${request.url}/`, grant);
      const limit = budget(grant);
      const upstream = dial(address, 443);
      sockets.add(client);
      sockets.add(upstream);
      const timer = setTimeout(
        () => {
          client.destroy();
          upstream.destroy();
        },
        Math.max(1, grant.expiresAt - now()),
      );
      timer.unref();
      const close = () => {
        clearTimeout(timer);
        limit.release();
        sockets.delete(client);
        sockets.delete(upstream);
        client.destroy();
        upstream.destroy();
      };
      client.once('error', close);
      client.once('close', close);
      upstream.once('error', close);
      upstream.once('close', close);
      if (client instanceof Socket) client.setTimeout(30_000, close);
      upstream.setTimeout(30_000, close);
      for (const socket of [client, upstream])
        socket.on('data', (chunk: Buffer) => {
          if (!limit.add(chunk.length)) close();
        });
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length && limit.add(head.length)) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    })().catch(() => {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  return {
    server,
    async close() {
      for (const socket of sockets) socket.destroy();
      await closeHttp(server);
    },
  };
}
