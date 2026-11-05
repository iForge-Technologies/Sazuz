const maximumBodyBytes = 256 * 1024;
const signatureHeaders = ['x-sazuz-timestamp', 'x-sazuz-delivery', 'x-sazuz-signature'] as const;

function failure(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

export async function forwardWebhook(
  request: Request,
  id: string,
  serverOrigin: string,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!/^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/.test(id))
    return failure(404, 'NOT_FOUND', 'Webhook unavailable.');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBodyBytes))
    return failure(413, 'REQUEST_TOO_LARGE', 'Webhook payload too large.');
  const headers = new Headers({
    'content-type': request.headers.get('content-type') ?? 'application/octet-stream',
  });
  for (const key of signatureHeaders) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = request.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > maximumBodyBytes) {
            await reader.cancel();
            return failure(413, 'REQUEST_TOO_LARGE', 'Webhook payload too large.');
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const target = new URL(`/hooks/${id}`, new URL(serverOrigin));
    const response = await fetcher(target, {
      method: 'POST',
      headers,
      body,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    });
    return new Response(response.body, {
      status: response.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return failure(
      503,
      'WEBHOOK_UNAVAILABLE',
      'Webhook processing is unavailable. Try again shortly.',
    );
  }
}
