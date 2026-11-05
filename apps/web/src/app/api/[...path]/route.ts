import type { NextRequest } from 'next/server';
import { readRequestBody, RequestBodyError } from '../../../lib/request-body';

export const dynamic = 'force-dynamic';
async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (
    ![
      'setup',
      'auth',
      'vault',
      'settings',
      'projects',
      'threads',
      'providers',
      'models',
      'costs',
      'observability',
      'evals',
      'missions',
      'runs',
      'approvals',
      'policies',
      'control',
      'triggers',
      'notifications',
      'digests',
      'channels',
      'connectors',
      'memory',
      'kb',
      'skills',
      'recipes',
      'sandbox',
      'browser',
      'agents',
      'mcp',
      'bridge',
      'workflows',
      'passkeys',
      'audit',
      'operations',
      'backups',
      'voice',
    ].includes(path[0] ?? '') ||
    path.some((part) => !/^[a-zA-Z0-9_-]+$/.test(part))
  )
    return Response.json(
      { error: { code: 'NOT_FOUND', message: 'Endpoint unavailable.' } },
      { status: 404 },
    );
  const headers = new Headers({ accept: 'application/json' });
  for (const key of ['cookie', 'origin', 'content-type', 'sec-fetch-site', 'user-agent']) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  try {
    const origin = new URL(process.env.SAZUZ_SERVER_URL ?? 'http://127.0.0.1:7778');
    const target = new URL(`/api/${path.join('/')}`, origin);
    target.search = request.nextUrl.search;
    const maxBytes =
      path[0] === 'voice' && path[1] === 'transcribe'
        ? 1_300_000
        : path[0] === 'kb' && path[1] === 'sources' && path[2] === 'upload'
          ? 12_000_000
          : 131_072;
    const body = ['GET', 'HEAD'].includes(request.method)
      ? undefined
      : await readRequestBody(request, maxBytes);
    const streaming = path[0] === 'threads' && path[2] === 'chat';
    const response = await fetch(target, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'error',
      cache: 'no-store',
      signal: streaming
        ? request.signal
        : AbortSignal.any([
            request.signal,
            AbortSignal.timeout(
              path[0] === 'backups' || (path[0] === 'setup' && path[1] === 'restore')
                ? 150_000
                : path[0] === 'mcp'
                  ? 55_000
                  : path[0] === 'skills' || path[0] === 'voice'
                    ? 60_000
                    : 15_000,
            ),
          ]),
    });
    if (
      path.length === 3 &&
      path[0] === 'backups' &&
      /^bak_[0-9A-HJKMNP-TV-Z]{26}$/.test(path[1] ?? '') &&
      path[2] === 'download' &&
      request.method === 'GET' &&
      response.ok &&
      response.headers.get('content-type') === 'application/octet-stream'
    ) {
      return new Response(response.body, {
        status: response.status,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${path[1]}.sazuz"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    }
    const htmlReport =
      path.length === 3 &&
      path[0] === 'evals' &&
      path[2] === 'report' &&
      request.method === 'GET' &&
      response.ok &&
      response.headers.get('content-type')?.startsWith('text/html');
    const outgoing = new Headers({
      'content-type': htmlReport
        ? 'text/html; charset=utf-8'
        : streaming && response.ok
          ? 'text/event-stream'
          : 'application/json',
      'cache-control': 'no-store',
    });
    if (htmlReport) {
      outgoing.set(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox",
      );
      outgoing.set('x-content-type-options', 'nosniff');
    }
    for (const cookie of response.headers.getSetCookie()) outgoing.append('set-cookie', cookie);
    return new Response(streaming && response.ok ? response.body : await response.text(), {
      status: response.status,
      headers: outgoing,
    });
  } catch (error) {
    if (error instanceof RequestBodyError)
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: { 'cache-control': 'no-store' } },
      );
    return Response.json(
      {
        error: { code: 'SERVER_UNAVAILABLE', message: 'Sazuz is unavailable. Try again shortly.' },
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
export { forward as GET, forward as POST, forward as PUT, forward as DELETE };
