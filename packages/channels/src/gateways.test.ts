import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { channelConnectionSchema } from '@sazuz/config/integrations';
import {
  acceptsSender,
  parseChannelPayload,
  sendChannelText,
  verifyChannelSignature,
} from './gateways.js';
const base = {
  id: 'channel',
  name: 'Channel',
  projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  enabled: true,
  allowedSenders: ['U123'],
  applicationId: 'A123',
};
const credential = 'secret://sec_01ARZ3NDEKTSV4RRFFQ69G5FAV';
describe('authenticated channel protocols', () => {
  it('verifies Slack signatures against raw bytes and rejects expired or modified payloads', () => {
    const connection = channelConnectionSchema.parse({ ...base, kind: 'slack' });
    const body = Buffer.from('{"event":"sample"}');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const secret = 'fixture-signing-key';
    const headers = {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex')}`,
    };
    expect(() => verifyChannelSignature(connection, headers, body, secret)).not.toThrow();
    expect(() => verifyChannelSignature(connection, headers, Buffer.from('{}'), secret)).toThrow();
    expect(() =>
      verifyChannelSignature(connection, headers, body, secret, Date.now() + 600_000),
    ).toThrow();
  });
  it('verifies Discord Ed25519 and rejects a different application', () => {
    const pair = generateKeyPairSync('ed25519');
    const publicKey = pair.publicKey
      .export({ type: 'spki', format: 'der' })
      .subarray(-32)
      .toString('hex');
    const connection = channelConnectionSchema.parse({ ...base, kind: 'discord', publicKey });
    const body = Buffer.from('{"type":1}');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      'x-signature-timestamp': timestamp,
      'x-signature-ed25519': sign(
        null,
        Buffer.concat([Buffer.from(timestamp), body]),
        pair.privateKey,
      ).toString('hex'),
    };
    expect(() => verifyChannelSignature(connection, headers, body)).not.toThrow();
    expect(parseChannelPayload(connection, { type: 1 })).toEqual({ events: [], discordPing: true });
    expect(parseChannelPayload(connection, { type: 2, application_id: 'other' }).events).toEqual(
      [],
    );
  });
  it('filters bot messages, preserves Slack threads and requires explicit sender access', () => {
    const connection = channelConnectionSchema.parse({
      ...base,
      kind: 'slack',
      allowedConversations: ['C123'],
    });
    const payload = {
      type: 'event_callback',
      api_app_id: 'A123',
      event_id: 'event1',
      event: {
        type: 'app_mention',
        user: 'U123',
        channel: 'C123',
        text: '<@BOT1> Research this',
        ts: '12345.1234',
      },
    };
    const event = parseChannelPayload(connection, payload).events[0]!;
    expect(event).toMatchObject({ conversation: 'C123:12345.1234', text: 'Research this' });
    expect(acceptsSender(connection, event)).toBe(true);
    expect(acceptsSender(connection, { ...event, sender: 'stranger' })).toBe(false);
    expect(
      parseChannelPayload(connection, { ...payload, event: { ...payload.event, bot_id: 'BOT1' } })
        .events,
    ).toEqual([]);
  });
  it('verifies WhatsApp signatures and ignores status-only webhooks', () => {
    const connection = channelConnectionSchema.parse({
      ...base,
      kind: 'whatsapp-cloud',
      phoneNumberId: '123',
    });
    const body = Buffer.from('{}');
    const secret = 'fixture-meta-signing-key';
    expect(() =>
      verifyChannelSignature(
        connection,
        {
          'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
        },
        body,
        secret,
      ),
    ).not.toThrow();
    expect(
      parseChannelPayload(connection, {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: { metadata: { phone_number_id: '123' }, statuses: [] } }] }],
      }).events,
    ).toEqual([]);
  });
  it('uses fixed official endpoints, disables Discord mentions and redacts transport errors', async () => {
    const connection = channelConnectionSchema.parse({
      ...base,
      kind: 'discord',
      secretRef: credential,
    });
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      expect(init?.redirect).toBe('error');
      expect(JSON.parse(z.string().parse(init?.body))).toMatchObject({
        allowed_mentions: { parse: [] },
      });
      return Promise.resolve(Response.json({ id: 'message1' }));
    });
    const secret = async <T>(_ref: string, consume: (value: string) => Promise<T>) =>
      consume('unique-fixture-token-123456');
    await expect(
      sendChannelText(connection, '1234', 'Hello @everyone', secret, fetcher),
    ).resolves.toEqual({ id: 'message1' });
    await expect(
      sendChannelText(connection, '../../other', 'Hello', secret, fetcher),
    ).rejects.toThrow();
    fetcher.mockRejectedValue(new Error('unique-fixture-token-123456'));
    await expect(
      sendChannelText(connection, '1234', 'Hello', secret, fetcher),
    ).rejects.toMatchObject({
      code: 'DELIVERY_FAILED',
      delivery: 'unknown',
    });
  });
});
