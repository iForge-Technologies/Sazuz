import { z } from 'zod';

const messages = {
  REQUEST_TOO_LARGE: 'Request too large.',
  REQUEST_INVALID: 'The request body must contain valid UTF-8 text.',
  REQUEST_TIMEOUT: 'The request body did not arrive in time.',
} as const;

export class RequestBodyError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'RequestBodyError';
  }
  get status() {
    return this.code === 'REQUEST_TOO_LARGE' ? 413 : this.code === 'REQUEST_TIMEOUT' ? 408 : 400;
  }
}

/** Enforce the byte limit during receipt, including chunked requests and dishonest length headers. */
export async function readRequestBody(request: Request, maximumBytes: number, timeoutMs = 10_000) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
    throw new RequestBodyError('REQUEST_INVALID');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  let complete = false;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
  let abort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new RequestBodyError('REQUEST_TIMEOUT'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    if (length !== null && Number(length) > maximumBytes)
      throw new RequestBodyError('REQUEST_TOO_LARGE');
    if (signal.aborted) throw new RequestBodyError('REQUEST_TIMEOUT');
    for (;;) {
      const item = await Promise.race([reader.read(), cancelled]);
      if (item.done) break;
      const value = z.instanceof(Uint8Array).parse(item.value);
      bytes += value.byteLength;
      if (bytes > maximumBytes) throw new RequestBodyError('REQUEST_TOO_LARGE');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    complete = true;
    return chunks.join('');
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError('REQUEST_INVALID');
  } finally {
    chunks.length = 0;
    signal.removeEventListener('abort', abort);
    if (!complete) {
      // Do not wait on a peer's cancellation hook. A failed stream already has
      // the typed primary error above; cancellation cannot replace that result.
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
