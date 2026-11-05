import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { readInfraConfig } from '@sazuz/config';
import { BrowserError } from '@sazuz/core/browser';
import { workerBrowserImage } from './image.js';
import { browserImageRequestSchema, verifyBrowserMessage } from './protocol.js';

describe('worker image transport failure boundaries', () => {
  it.each(['unavailable', 'malformed', 'redirect', 'withheld'] as const)(
    'handles a real %s response without disclosing transport contents or following redirects',
    async (mode) => {
      const canary = 'image-transport-canary-478156';
      const key = randomBytes(32).toString('base64url');
      let redirected = 0,
        requests = 0,
        invalidRequest = false;
      const server = createServer((request, response) => {
        void (async () => {
          if (request.url === '/untrusted') {
            redirected++;
            response.end('{}');
            return;
          }
          let source = '';
          for await (const chunk of request) source += String(chunk);
          const message = browserImageRequestSchema.parse(JSON.parse(source));
          verifyBrowserMessage(
            key,
            'worker-image',
            message,
            request.headers['x-sazuz-worker-signature'],
          );
          expect(source).not.toContain(canary);
          requests++;
          if (mode === 'unavailable') response.writeHead(503).end(canary);
          else if (mode === 'redirect') response.writeHead(307, { location: '/untrusted' }).end();
          else {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ image: mode === 'withheld' ? null : canary }));
          }
        })().catch(() => {
          invalidRequest = true;
          response.writeHead(500).end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const image = workerBrowserImage({
          config: readInfraConfig({
            SAZUZ_SERVER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          }),
          workerId: 'wrk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          key: () => Promise.resolve(key),
        });
        const scope = {
          runId: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          claimKey: randomUUID(),
          additionalExecutionContext: canary,
        };
        const result = image(
          scope,
          {
            sessionId: 'bsn_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            imageHandle: `bim_${'a'.repeat(32)}`,
            sourceCallKey: `${scope.runId}:1:0`,
          },
          AbortSignal.timeout(5000),
        );
        if (mode === 'withheld') await expect(result).resolves.toBeNull();
        else {
          const failure: unknown = await result.catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(BrowserError);
          expect(failure).toMatchObject({ code: 'BROWSER_UNAVAILABLE' });
          expect(String(failure)).not.toContain(canary);
          expect(String(failure)).not.toContain(key);
        }
        expect(requests).toBe(1);
        expect(redirected).toBe(0);
        expect(invalidRequest).toBe(false);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
