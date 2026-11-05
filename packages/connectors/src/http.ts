import { checkAbort, ToolError } from '@sazuz/tools';
import type { z } from 'zod';
import { ConnectorError } from './errors.js';
import { request as requestHttps } from 'node:https';
import type { LookupFunction } from 'node:net';
import { resolvePublicUrl, type ToolContext } from '@sazuz/tools';

export async function boundedOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        listener = () => reject(new ToolError('TOOL_ABORTED'));
        signal.addEventListener('abort', listener, { once: true });
      }),
    ]);
  } finally {
    if (listener !== undefined) signal.removeEventListener('abort', listener);
  }
}

const maxResponseBytes = 1_048_576;

/** Only callers with fixed official API origins use this authenticated transport. */
export async function requestJson(
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ status: number; body: unknown }> {
  if (
    ![
      'https://gmail.googleapis.com',
      'https://www.googleapis.com',
      'https://oauth2.googleapis.com',
      'https://api.github.com',
      'https://sheets.googleapis.com',
      'https://docs.googleapis.com',
      'https://graph.microsoft.com',
      'https://login.microsoftonline.com',
      'https://slack.com',
      'https://discord.com',
      'https://api.notion.com',
      'https://api.todoist.com',
      'https://api.linear.app',
      'https://api.stripe.com',
    ].includes(url.origin)
  )
    throw new ConnectorError('REQUEST_REJECTED');
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  checkAbort(bounded);
  try {
    const response = await boundedOperation(
      fetcher(url, { ...init, redirect: 'error', signal: bounded }),
      bounded,
    );
    const advertised = response.headers.get('content-length');
    if (
      advertised !== null &&
      (!/^\d+$/.test(advertised) || Number(advertised) > maxResponseBytes)
    ) {
      await response.body?.cancel();
      throw new ToolError('RESPONSE_TOO_LARGE');
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader !== undefined) {
      try {
        for (;;) {
          const chunk = await boundedOperation(reader.read(), bounded);
          if (chunk.done) break;
          const value: unknown = chunk.value;
          if (!(value instanceof Uint8Array)) throw new ConnectorError('INVALID_RESPONSE');
          bytes += value.byteLength;
          if (bytes > maxResponseBytes) throw new ToolError('RESPONSE_TOO_LARGE');
          chunks.push(value);
        }
      } finally {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return {
      status: response.status,
      body: text.length === 0 ? null : (JSON.parse(text) as unknown),
    };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ConnectorError(bounded.aborted ? 'TRANSPORT_FAILED' : 'INVALID_RESPONSE');
  }
}

export function parseResponse<T extends z.ZodType>(value: unknown, schema: T): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ConnectorError('INVALID_RESPONSE');
  return parsed.data;
}

export function requireSuccess(status: number): void {
  if (status < 200 || status >= 300) throw new ConnectorError('REQUEST_REJECTED');
}

/** Custom account origins are DNS-pinned; redirects never carry credentials elsewhere. */
export async function requestScopedText(
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: string },
  context: Pick<ToolContext, 'network' | 'signal'>,
  fetcher?: typeof fetch,
): Promise<{ status: number; text: string; etag: string | null }> {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]);
  const resolved = await boundedOperation(resolvePublicUrl(url.href, context.network), signal);
  if (resolved.url.protocol !== 'https:') throw new ConnectorError('REQUEST_REJECTED');
  checkAbort(signal);
  if (fetcher) {
    const response = await boundedOperation(
      fetcher(url, { ...init, redirect: 'error', signal }),
      signal,
    );
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (reader) {
        const part = await boundedOperation(reader.read(), signal);
        if (part.done) break;
        const bytes: unknown = part.value;
        if (!(bytes instanceof Uint8Array)) throw new ConnectorError('INVALID_RESPONSE');
        size += bytes.byteLength;
        if (size > maxResponseBytes) throw new ConnectorError('INVALID_RESPONSE');
        chunks.push(bytes);
      }
    } finally {
      if (reader) {
        await reader.cancel();
        reader.releaseLock();
      }
    }
    return {
      status: response.status,
      text: Buffer.concat(chunks).toString('utf8'),
      etag: response.headers.get('etag'),
    };
  }
  return new Promise((resolve, reject) => {
    const lookup: LookupFunction = (_host, options, callback) => {
      if (options.all) callback(null, [resolved.address]);
      else callback(null, resolved.address.address, resolved.address.family);
    };
    const request = requestHttps(
      url,
      {
        ...init,
        agent: false,
        lookup,
        signal,
        headers: { ...init.headers, 'accept-encoding': 'identity' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (part: Buffer) => {
          size += part.length;
          if (
            size > maxResponseBytes ||
            (response.headers['content-encoding'] &&
              response.headers['content-encoding'] !== 'identity')
          )
            response.destroy();
          else chunks.push(part);
        });
        response.once('error', () => reject(new ConnectorError('TRANSPORT_FAILED')));
        response.once('aborted', () => reject(new ConnectorError('TRANSPORT_FAILED')));
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 502,
            text: Buffer.concat(chunks).toString('utf8'),
            etag: response.headers.etag ?? null,
          }),
        );
      },
    );
    request.once('error', () => reject(new ConnectorError('TRANSPORT_FAILED')));
    request.end(init.body);
  });
}
