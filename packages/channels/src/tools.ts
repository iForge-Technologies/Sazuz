import { z } from 'zod';
import { defineTool, type ToolContext } from '@sazuz/tools';
export const channelSendSchema = z.strictObject({
  connectionId: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  conversation: z.string().min(1).max(200),
  text: z.string().min(1).max(8000),
});
export function createChannelTool(send: (ctx: ToolContext) => Promise<{ id: string }>) {
  return defineTool({
    name: 'channel.send',
    description:
      'Send text through a configured Discord, Slack or WhatsApp channel. Requires channel and recipient permission and policy approval.',
    input: channelSendSchema,
    output: z.object({ id: z.string() }),
    effect: 'send',
    scope: 'external',
    connector: 'channels',
    run: (ctx) => send(ctx),
  });
}
