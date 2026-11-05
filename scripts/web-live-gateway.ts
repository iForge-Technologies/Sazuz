import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { readInfraConfig, type InfraConfig } from '@sazuz/config';

export const WEB_LIVE_PORT = 17779;

/** Fixed-path upgrade proxy; the target origin is validated infrastructure, never a request URL. */
export async function startWebLiveGateway(
  config: Pick<InfraConfig, 'serverUrl'> = readInfraConfig(),
  port = WEB_LIVE_PORT,
) {
  const origin = new URL(config.serverUrl);
  const connections = new Set<Duplex>();
  const server = createServer({ maxHeaderSize: 16384 }, (_request, response) => {
    response.writeHead(404, { 'cache-control': 'no-store' });
    response.end();
  });
  server.on('upgrade', (request, client, head) => {
    client.on('error', () => client.destroy());
    if (
      request.method !== 'GET' ||
      !(
        request.url === '/bridge' ||
        /^\/live\/browser\/bsn_[0-9A-HJKMNP-TV-Z]{26}$/.test(request.url ?? '')
      ) ||
      connections.size >= 32
    ) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    connections.add(client);
    const headers: IncomingHttpHeaders = {
      host: origin.host,
      connection: 'Upgrade',
      upgrade: 'websocket',
    };
    for (const name of [
      'cookie',
      'origin',
      'sec-fetch-site',
      'sec-websocket-key',
      'sec-websocket-version',
      'sec-websocket-protocol',
    ])
      if (request.headers[name]) headers[name] = request.headers[name];
    if (request.url === '/bridge') {
      delete headers.cookie;
      for (const name of ['authorization', 'x-sazuz-device'])
        if (request.headers[name]) headers[name] = request.headers[name];
    }
    const outgoing = (origin.protocol === 'https:' ? httpsRequest : httpRequest)(
      new URL(request.url!, origin),
      { method: 'GET', headers, timeout: 5000 },
    );
    client.once('close', () => {
      connections.delete(client);
      outgoing.destroy();
    });
    outgoing.once('timeout', () => outgoing.destroy());
    outgoing.once('error', () => client.destroy());
    outgoing.once('response', (response) => {
      response.resume();
      client.end(
        `HTTP/1.1 ${response.statusCode ?? 502} Unavailable\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n`,
      );
    });
    outgoing.once('upgrade', (response, upstream, upstreamHead) => {
      outgoing.setTimeout(0);
      upstream.on('error', () => client.destroy());
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
      if (client.destroyed) {
        upstream.destroy();
        return;
      }
      const accept = response.headers['sec-websocket-accept'];
      if (typeof accept !== 'string') {
        upstream.destroy();
        client.destroy();
        return;
      }
      client.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      if (upstreamHead.length) client.write(upstreamHead);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    outgoing.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server,
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
