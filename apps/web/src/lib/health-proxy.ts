import { z } from 'zod';

import { healthUnavailableSchema, parseHealthResponse } from './health-response';

const serverOriginSchema = z
  .string()
  .url()
  .transform((value) => new URL(value))
  .refine(
    (url) =>
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '',
  );

const responseHeaders = {
  'cache-control': 'no-store',
  'content-type': 'application/json',
};

function unavailableResponse(): Response {
  return Response.json(healthUnavailableSchema.parse({ error: { code: 'HEALTH_UNAVAILABLE' } }), {
    status: 503,
    headers: responseHeaders,
  });
}

export async function proxyHealth(
  serverOrigin: unknown = 'http://127.0.0.1:7778',
): Promise<Response> {
  const origin = serverOriginSchema.safeParse(serverOrigin);
  if (!origin.success) return unavailableResponse();

  try {
    const response = await fetch(new URL('/api/health', origin.data), {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(3_000),
    });
    const payload: unknown = await response.json();
    const health = parseHealthResponse(response.status, payload);
    return Response.json(health, {
      status: health.status === 'ok' ? 200 : 503,
      headers: responseHeaders,
    });
  } catch {
    // Translate failed requests and invalid responses into one safe, typed public error.
    return unavailableResponse();
  }
}
