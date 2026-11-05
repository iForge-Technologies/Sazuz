import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { SandboxError } from '@sazuz/core/sandbox';

export async function readBounded(request: IncomingMessage, maximum = 131_072): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    bytes += chunk.length;
    if (bytes > maximum) throw new SandboxError('SANDBOX_INVALID');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function rejectRequest(response: ServerResponse, code = 403): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ message: 'The infrastructure request was refused.' }));
}
export function closeHttp(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
