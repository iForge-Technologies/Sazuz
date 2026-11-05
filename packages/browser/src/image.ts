import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { InfraConfig } from '@sazuz/config';
import { browserImageSchema, BrowserError } from '@sazuz/core/browser';
import { browserImageRequestSchema, signBrowserMessage } from './protocol.js';

export function workerBrowserImage(options: {
  config: InfraConfig;
  workerId: string;
  key: () => Promise<string>;
  fetch?: typeof fetch;
}) {
  return async (
    scope: { runId: string | null; claimKey: string | null },
    image: { sessionId: string; imageHandle: string; sourceCallKey: string },
    signal: AbortSignal,
  ) => {
    const request = browserImageRequestSchema.parse({
      ...image,
      runId: scope.runId,
      claimKey: scope.claimKey,
      workerId: options.workerId,
      nonce: randomUUID(),
      expiresAt: Date.now() + 45000,
    });
    try {
      const response = await (options.fetch ?? fetch)(
        new URL('/internal/browser-image', options.config.serverUrl),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-sazuz-worker-signature': signBrowserMessage(
              await options.key(),
              'worker-image',
              request,
            ),
          },
          body: JSON.stringify(request),
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
          redirect: 'error',
        },
      );
      if (!response.ok) throw new BrowserError('BROWSER_UNAVAILABLE');
      return z.strictObject({ image: browserImageSchema.nullable() }).parse(await response.json())
        .image;
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError('BROWSER_UNAVAILABLE');
    }
  };
}
