import { proxyHealth } from '../../../lib/health-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(): Promise<Response> {
  return proxyHealth(process.env.SAZUZ_SERVER_URL);
}
