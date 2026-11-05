import type { InfraConfig } from '@sazuz/config';
import { BrowserError } from '@sazuz/core/browser';
import {
  browserRpcResultSchema,
  rpcMessage,
  signBrowserMessage,
  type BrowserRpc,
} from './protocol.js';

export function createBrowserClient(
  config: Pick<InfraConfig, 'browserUrl'>,
  key: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  return async (input: Omit<BrowserRpc, 'nonce' | 'expiresAt'>, signal?: AbortSignal) => {
    const request = rpcMessage(input),
      signature = signBrowserMessage(await key(), 'service', request);
    try {
      const response = await fetcher(new URL('/internal/browser', config.browserUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sazuz-browser-signature': signature },
        body: JSON.stringify(request),
        signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
        redirect: 'error',
      });
      if (!response.ok)
        throw new BrowserError(
          response.status === 409
            ? 'BROWSER_UNCERTAIN'
            : response.status === 403
              ? 'BROWSER_DENIED'
              : 'BROWSER_UNAVAILABLE',
        );
      const text = await response.text();
      if (text.length > 2200000) throw new BrowserError('BROWSER_INVALID');
      return browserRpcResultSchema.parse(JSON.parse(text));
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError('BROWSER_UNAVAILABLE');
    }
  };
}
export type BrowserClient = ReturnType<typeof createBrowserClient>;
