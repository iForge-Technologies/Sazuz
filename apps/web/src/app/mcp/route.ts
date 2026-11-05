import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
async function forward(request: NextRequest) {
  if (request.nextUrl.search) return Response.json({ error: 'Unexpected query.' }, { status: 400 });
  const headers = new Headers();
  for (const key of ['authorization', 'content-type', 'accept', 'mcp-protocol-version', 'origin']) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  const body = request.method === 'POST' ? await request.text() : undefined;
  if (body && new TextEncoder().encode(body).length > 131_072)
    return Response.json({ error: 'Request too large.' }, { status: 413 });
  try {
    const response = await fetch(
      new URL('/mcp', process.env.SAZUZ_SERVER_URL ?? 'http://127.0.0.1:7778'),
      {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'error',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
        cache: 'no-store',
      },
    );
    return new Response(response.body, {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
        ...(response.headers.get('allow') ? { allow: response.headers.get('allow')! } : {}),
      },
    });
  } catch {
    return Response.json({ error: 'MCP is unavailable.' }, { status: 503 });
  }
}
export { forward as POST, forward as GET, forward as DELETE };
