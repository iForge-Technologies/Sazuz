import { forwardChannelWebhook } from '../../../../lib/channel-webhook-proxy';
export const dynamic = 'force-dynamic';
async function forward(request: Request, context: { params: Promise<{ id: string }> }) {
  return forwardChannelWebhook(
    request,
    (await context.params).id,
    process.env.SAZUZ_SERVER_URL ?? 'http://127.0.0.1:7778',
  );
}
export { forward as GET, forward as POST };
