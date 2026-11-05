const settingsPath = '/settings?section=connectors&oauth=';

export async function forwardGoogleCallback(
  request: Request,
  serverOrigin: string,
  fetcher: typeof fetch = fetch,
  provider: 'google' | 'microsoft' = 'google',
): Promise<Response> {
  const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  let outcome = 'failed';
  try {
    const incoming = new URL(request.url);
    if (incoming.search.length > 16_384) throw new Error('Invalid callback.');
    const target = new URL(`/oauth/${provider}/callback`, serverOrigin);
    for (const key of ['code', 'state', 'error']) {
      const values = incoming.searchParams.getAll(key);
      if (values.length > 1) throw new Error('Invalid callback.');
      if (values[0]) target.searchParams.set(key, values[0]);
    }
    const forwarded = new Headers({ accept: 'application/json' });
    const cookie = request.headers.get('cookie');
    if (cookie) forwarded.set('cookie', cookie);
    const response = await fetcher(target, {
      method: 'GET',
      headers: forwarded,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    });
    const location = response.headers.get('location');
    if ([302, 303].includes(response.status) && location) {
      const destination = new URL(location, request.url);
      if (
        destination.pathname === '/settings' &&
        destination.searchParams.get('section') === 'connectors' &&
        destination.searchParams.get('oauth') === 'connected'
      )
        outcome = 'connected';
    }
    for (const value of response.headers.getSetCookie()) headers.append('set-cookie', value);
  } catch {
    // A callback failure is reported in Settings without reflecting OAuth codes or provider errors.
    outcome = 'failed';
  }
  headers.set('location', `${settingsPath}${outcome}`);
  return new Response(null, { status: 303, headers });
}
