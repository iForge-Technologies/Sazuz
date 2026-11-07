import { createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { z } from 'zod';
import type { ChannelConnection } from '@sazuz/config/integrations';
import { secretRedactor } from '@sazuz/vault';

export class ChannelError extends Error {
  constructor(
    readonly code:
      'SIGNATURE_INVALID' | 'PAYLOAD_INVALID' | 'CHANNEL_UNAVAILABLE' | 'DELIVERY_FAILED',
    readonly delivery: 'not_sent' | 'unknown' = 'unknown',
  ) {
    super('The channel operation could not be completed. Check channel configuration and status.');
    this.name = 'ChannelError';
  }
}
export const inboundSchema = z.strictObject({
  id: z.string().min(1).max(200),
  sender: z.string().min(1).max(160),
  conversation: z.string().min(1).max(200),
  text: z.string().trim().min(1).max(8000),
});
export type ChannelInbound = z.infer<typeof inboundSchema>;
const header = (headers: Record<string, string | string[] | undefined>, key: string) =>
  typeof headers[key] === 'string' ? headers[key] : '';
function equal(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function verifyChannelSignature(
  connection: ChannelConnection,
  headers: Record<string, string | string[] | undefined>,
  body: Uint8Array,
  secret?: string,
  now = Date.now(),
): void {
  if (body.byteLength > 131_072) throw new ChannelError('PAYLOAD_INVALID', 'not_sent');
  const timestamp = header(
    headers,
    connection.kind === 'discord' ? 'x-signature-timestamp' : 'x-slack-request-timestamp',
  );
  if (
    connection.kind !== 'whatsapp-cloud' &&
    (!/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300)
  )
    throw new ChannelError('SIGNATURE_INVALID', 'not_sent');
  try {
    if (connection.kind === 'discord') {
      const signature = header(headers, 'x-signature-ed25519');
      if (!/^[a-fA-F0-9]{128}$/.test(signature) || !/^[a-fA-F0-9]{64}$/.test(connection.publicKey))
        throw new Error();
      const key = createPublicKey({
        key: Buffer.concat([
          Buffer.from('302a300506032b6570032100', 'hex'),
          Buffer.from(connection.publicKey, 'hex'),
        ]),
        format: 'der',
        type: 'spki',
      });
      if (
        !verify(
          null,
          Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]),
          key,
          Buffer.from(signature, 'hex'),
        )
      )
        throw new Error();
    } else if (connection.kind === 'slack') {
      if (!secret) throw new Error();
      const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex')}`;
      if (!equal(expected, header(headers, 'x-slack-signature'))) throw new Error();
    } else if (connection.kind === 'whatsapp-cloud') {
      if (!secret) throw new Error();
      const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      if (!equal(expected, header(headers, 'x-hub-signature-256'))) throw new Error();
    } else throw new Error();
  } catch {
    throw new ChannelError('SIGNATURE_INVALID', 'not_sent');
  }
}
export function parseChannelPayload(
  connection: ChannelConnection,
  value: unknown,
): { events: ChannelInbound[]; challenge?: string; discordPing?: boolean } {
  try {
    if (connection.kind === 'discord') {
      const body = z
        .object({
          type: z.number().int(),
          id: z.string().optional(),
          application_id: z.string().optional(),
          channel_id: z.string().optional(),
          user: z.object({ id: z.string(), bot: z.boolean().optional() }).optional(),
          member: z
            .object({ user: z.object({ id: z.string(), bot: z.boolean().optional() }) })
            .optional(),
          data: z
            .object({
              name: z.string(),
              options: z.array(z.object({ name: z.string(), value: z.unknown() })).optional(),
            })
            .optional(),
        })
        .parse(value);
      if (body.type === 1) return { events: [], discordPing: true };
      if (body.application_id !== connection.applicationId || body.type !== 2)
        return { events: [] };
      const sender = body.member?.user ?? body.user;
      if (!sender || sender.bot || !body.data || body.data.name !== 'sazuz') return { events: [] };
      const text = body.data.options?.find((item) => item.name === 'task')?.value;
      return {
        events: [
          inboundSchema.parse({
            id: body.id,
            sender: sender.id,
            conversation: body.channel_id,
            text,
          }),
        ],
      };
    }
    if (connection.kind === 'slack') {
      const body = z
        .object({
          type: z.string(),
          challenge: z.string().max(2000).optional(),
          api_app_id: z.string().optional(),
          event_id: z.string().optional(),
          event: z
            .object({
              type: z.string(),
              user: z.string().optional(),
              channel: z.string().optional(),
              text: z.string().optional(),
              ts: z.string().optional(),
              thread_ts: z.string().optional(),
              bot_id: z.string().optional(),
              subtype: z.string().optional(),
              channel_type: z.string().optional(),
            })
            .optional(),
        })
        .parse(value);
      if (body.type === 'url_verification' && body.challenge)
        return { events: [], challenge: body.challenge };
      if (body.api_app_id !== connection.applicationId || body.type !== 'event_callback')
        return { events: [] };
      const event = body.event;
      if (
        !event ||
        event.bot_id ||
        event.subtype ||
        !(event.type === 'app_mention' || (event.type === 'message' && event.channel_type === 'im'))
      )
        return { events: [] };
      return {
        events: [
          inboundSchema.parse({
            id: body.event_id,
            sender: event.user,
            conversation: `${event.channel}:${event.thread_ts ?? event.ts}`,
            text: event.text?.replace(/<@[A-Z0-9]+>/g, '').trim(),
          }),
        ],
      };
    }
    if (connection.kind === 'whatsapp-cloud') {
      const body = z
        .object({
          object: z.literal('whatsapp_business_account'),
          entry: z
            .array(
              z.object({
                changes: z
                  .array(
                    z.object({
                      value: z.object({
                        metadata: z.object({ phone_number_id: z.string() }),
                        messages: z
                          .array(
                            z.object({
                              id: z.string(),
                              from: z.string(),
                              timestamp: z.string(),
                              type: z.string(),
                              text: z.object({ body: z.string() }).optional(),
                            }),
                          )
                          .max(100)
                          .optional(),
                      }),
                    }),
                  )
                  .max(100),
              }),
            )
            .max(100),
        })
        .parse(value);
      return {
        events: body.entry.flatMap((entry) =>
          entry.changes.flatMap(({ value }) =>
            value.metadata.phone_number_id === connection.phoneNumberId
              ? (value.messages ?? [])
                  .filter((item) => item.type === 'text' && item.text)
                  .map((item) =>
                    inboundSchema.parse({
                      id: item.id,
                      sender: item.from,
                      conversation: item.from,
                      text: item.text!.body,
                    }),
                  )
              : [],
          ),
        ),
      };
    }
    return { events: [] };
  } catch {
    throw new ChannelError('PAYLOAD_INVALID', 'not_sent');
  }
}
export function acceptsSender(connection: ChannelConnection, event: ChannelInbound): boolean {
  return (
    connection.enabled &&
    connection.allowedSenders.includes(event.sender) &&
    (connection.allowedConversations.length === 0 ||
      connection.allowedConversations.includes(event.conversation.split(':')[0]!))
  );
}
export async function sendChannelText(
  connection: ChannelConnection,
  conversation: string,
  text: string,
  secret: <T>(reference: string, consume: (value: string) => Promise<T>) => Promise<T>,
  fetcher: typeof fetch = fetch,
): Promise<{ id: string }> {
  if (!connection.enabled || !connection.secretRef || !text || text.length > 8000)
    throw new ChannelError('CHANNEL_UNAVAILABLE', 'not_sent');
  let url: string;
  let body: unknown;
  if (connection.kind === 'discord') {
    if (!/^\d{1,30}$/.test(conversation)) throw new ChannelError('PAYLOAD_INVALID', 'not_sent');
    url = `https://discord.com/api/v10/channels/${conversation}/messages`;
    body = { content: text.slice(0, 2000), allowed_mentions: { parse: [] } };
  } else if (connection.kind === 'slack') {
    const [channel, thread] = conversation.split(':');
    if (!/^[A-Z0-9]{1,30}$/.test(channel ?? '') || (thread && !/^\d+\.\d+$/.test(thread)))
      throw new ChannelError('PAYLOAD_INVALID', 'not_sent');
    url = 'https://slack.com/api/chat.postMessage';
    body = {
      channel,
      text: text.slice(0, 4000),
      ...(thread ? { thread_ts: thread } : {}),
      unfurl_links: false,
      unfurl_media: false,
      mrkdwn: false,
    };
  } else if (connection.kind === 'whatsapp-cloud') {
    if (!/^\d{5,20}$/.test(conversation) || !connection.phoneNumberId)
      throw new ChannelError('PAYLOAD_INVALID', 'not_sent');
    url = `https://graph.facebook.com/${connection.apiVersion}/${connection.phoneNumberId}/messages`;
    body = {
      messaging_product: 'whatsapp',
      to: conversation,
      type: 'text',
      text: { body: text.slice(0, 4096), preview_url: false },
    };
  } else throw new ChannelError('CHANNEL_UNAVAILABLE', 'not_sent');
  return secret(connection.secretRef, async (token) => {
    secretRedactor.register(token);
    try {
      const response = await fetcher(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `${connection.kind === 'discord' ? 'Bot' : 'Bearer'} ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (!reader) throw new ChannelError('DELIVERY_FAILED');
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const bytes = z.instanceof(Uint8Array).parse(chunk.value);
          size += bytes.length;
          if (size > 65_536) {
            await reader.cancel();
            throw new ChannelError('DELIVERY_FAILED');
          }
          chunks.push(bytes);
        }
      } finally {
        reader.releaseLock();
      }
      if (!response.ok)
        throw new ChannelError(
          'DELIVERY_FAILED',
          response.status >= 400 && response.status < 500 ? 'not_sent' : 'unknown',
        );
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (connection.kind === 'slack') {
        const parsed = z.object({ ok: z.boolean(), ts: z.string().optional() }).parse(result);
        if (!parsed.ok) throw new ChannelError('DELIVERY_FAILED', 'not_sent');
        return { id: z.string().min(1).parse(parsed.ts) };
      }
      return {
        id:
          connection.kind === 'discord'
            ? z.object({ id: z.string() }).parse(result).id
            : z.object({ messages: z.array(z.object({ id: z.string() })).min(1) }).parse(result)
                .messages[0]!.id,
      };
    } catch (error) {
      if (error instanceof ChannelError) throw error;
      throw new ChannelError('DELIVERY_FAILED');
    }
  });
}
