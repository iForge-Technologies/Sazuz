import { forwardWebhook } from '../../../lib/webhook-proxy';

export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forwardWebhook(request, id, process.env.SAZUZ_SERVER_URL ?? 'http://127.0.0.1:7778');
}
