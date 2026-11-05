import { forwardGoogleCallback } from '../../../../lib/oauth-proxy';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return forwardGoogleCallback(request, process.env.SAZUZ_SERVER_URL ?? 'http://127.0.0.1:7778');
}
