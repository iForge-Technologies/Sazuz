const maximumBodyBytes = 131_072;
const signatureHeaders = [
  'x-signature-ed25519',
  'x-signature-timestamp',
  'x-slack-signature',
  'x-slack-request-timestamp',
  'x-hub-signature-256',
];

export async function forwardChannelWebhook(
  request: Request,
  id: string,
  origin: string,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const failure = (status: number) =>
    new Response('Channel unavailable', { status, headers: { 'cache-control': 'no-store' } });
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id)) return failure(404);
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBodyBytes))
    return failure(413);
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
            return failure(413);
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
    const headers = new Headers({
      'content-type': request.headers.get('content-type') ?? 'application/json',
    });
    for (const key of signatureHeaders) {
      const value = request.headers.get(key);
      if (value) headers.set(key, value);
    }
    const target = new URL(`/channels/hooks/${id}`, origin);
    target.search = new URL(request.url).search;
    const response = await fetcher(target, {
      method: request.method,
      headers,
      ...(request.method === 'GET' ? {} : { body }),
      redirect: 'error',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      cache: 'no-store',
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return failure(503);
  }
}
