import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { requestPublicProtocol } from './network.js';

const https = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', () => ({ request: https.request }));
it('finishes an MCP response without waiting for a long-lived SSE connection to close', async () => {
  const stream = Object.assign(new PassThrough(), {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  const outbound = Object.assign(new EventEmitter(), {
    end: () => {
      queueMicrotask(() =>
        stream.write('data: {"jsonrpc":"2.0","id":"request1","result":{}}\n\ndata: {"partial":'),
      );
    },
  });
  https.request.mockImplementation(
    (_url: unknown, _options: unknown, receive: (response: unknown) => void) => {
      receive(stream);
      return outbound;
    },
  );
  const response = await requestPublicProtocol(
    'https://example.com/mcp',
    {
      method: 'POST',
      headers: {},
      body: '{}',
      responseId: 'request1',
      signal: AbortSignal.timeout(1000),
    },
    { lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]) },
  );
  expect(response.status).toBe(200);
  expect(response.body).toContain('"result":{}');
  expect(stream.destroyed).toBe(true);
});
