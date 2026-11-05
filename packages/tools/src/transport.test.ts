import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transportMock = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('node:http', () => ({ request: transportMock.send }));
vi.mock('node:https', () => ({ request: transportMock.send }));

import { fetchPublicText } from './network.js';

const requests: { url: URL; options: RequestOptions }[] = [];
let headers: Record<string, string>;
let chunks: Buffer[];

beforeEach(() => {
  requests.length = 0;
  headers = { 'content-type': 'text/plain' };
  chunks = [Buffer.from('hello')];
  transportMock.send.mockImplementation(
    (
      url: URL,
      options: RequestOptions,
      consume: (response: IncomingMessage) => void,
    ): ClientRequest => {
      requests.push({ url, options });
      const outbound = Object.assign(new EventEmitter(), {
        end() {
          const response = Object.assign(Readable.from(chunks), { headers, statusCode: 200 });
          consume(response as unknown as IncomingMessage);
          return outbound;
        },
      });
      return outbound as unknown as ClientRequest;
    },
  );
});

const dependencies = {
  lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 as const }]),
};

describe('default HTTP transport', () => {
  it('uses fresh sockets and pins both forms of Node lookup without forwarding credentials', async () => {
    await expect(
      fetchPublicText('https://example.com/article', new AbortController().signal, dependencies),
    ).resolves.toMatchObject({ text: 'hello' });
    const { url, options } = requests[0]!;
    expect(url.hostname).toBe('example.com');
    expect(options.agent).toBe(false);
    expect(options.headers).not.toHaveProperty('authorization');
    expect(options.headers).not.toHaveProperty('cookie');
    const lookup = options.lookup!;
    const single = vi.fn();
    const all = vi.fn();
    lookup('example.com', { family: 4 }, single);
    lookup('example.com', { all: true }, all);
    expect(single).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(all).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
  });

  it('rejects large Content-Length before consuming the body', async () => {
    headers['content-length'] = '1000';
    await expect(
      fetchPublicText('https://example.com/', new AbortController().signal, {
        ...dependencies,
        maxResponseBytes: 10,
      }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('bounds chunked responses even when Content-Length is absent', async () => {
    chunks = [Buffer.from('123456'), Buffer.from('789012')];
    await expect(
      fetchPublicText('https://example.com/', new AbortController().signal, {
        ...dependencies,
        maxResponseBytes: 10,
      }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('rejects unexpected compressed bodies rather than allowing a decompression bomb', async () => {
    headers['content-encoding'] = 'gzip';
    await expect(
      fetchPublicText('https://example.com/', new AbortController().signal, dependencies),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' });
  });
});
