import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWhatsAppQr } from './whatsapp-qr.js';
import type * as Baileys from '@whiskeysockets/baileys';

const vendor = vi.hoisted(() => ({
  handlers: new Map<string, (value: never) => void>(),
  send: vi.fn().mockResolvedValue({ key: { id: 'sent-message' } }),
  end: vi.fn().mockResolvedValue(undefined),
  logout: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@whiskeysockets/baileys', async (original) => ({
  ...(await original<typeof Baileys>()),
  makeWASocket: () => ({
    ev: {
      on: (name: string, handler: (value: never) => void) => vendor.handlers.set(name, handler),
    },
    sendMessage: vendor.send,
    end: vendor.end,
    logout: vendor.logout,
  }),
}));
const emit = (name: string, value: unknown) => vendor.handlers.get(name)?.(value as never);
function fixture() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      read: (key: string) => Promise.resolve(values.get(key) ?? null),
      write: vi.fn((key: string, value: string | null) => {
        if (value === null) values.delete(key);
        else values.set(key, value);
        return Promise.resolve();
      }),
      clear: vi.fn(() => {
        values.clear();
        return Promise.resolve();
      }),
    },
    receive: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
  };
}
beforeEach(() => {
  vendor.handlers.clear();
  vi.clearAllMocks();
});
describe('vault-backed WhatsApp linked devices', () => {
  it('clears credentials and signal keys on phone logout and ignores late credential writes', async () => {
    const options = fixture();
    const client = await connectWhatsAppQr(options);
    emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(options.values.has('creds')).toBe(true));
    options.values.set('session:fixture', 'encrypted-session-key');
    emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await vi.waitFor(() => expect(options.storage.clear).toHaveBeenCalledOnce());
    emit('creds.update', { registered: true });
    await client.close();
    expect(options.values.size).toBe(0);
    expect(options.onError).not.toHaveBeenCalled();
  });
  it('keeps vault credentials for restart but clears them on explicit unlink', async () => {
    const options = fixture();
    const first = await connectWhatsAppQr(options);
    emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(options.values.has('creds')).toBe(true));
    await first.close();
    expect(options.values.has('creds')).toBe(true);
    const second = await connectWhatsAppQr(options);
    await second.close(true);
    expect(vendor.logout).toHaveBeenCalledOnce();
    expect(options.values.size).toBe(0);
  });
  it('ignores history, groups and self-messages while accepting direct text', async () => {
    const options = fixture();
    const client = await connectWhatsAppQr(options);
    const message = {
      key: { id: 'inbound1', remoteJid: '12345@s.whatsapp.net' },
      message: { conversation: 'Hello' },
    };
    emit('messages.upsert', { type: 'append', messages: [message] });
    emit('messages.upsert', {
      type: 'notify',
      messages: [
        { ...message, key: { ...message.key, fromMe: true } },
        { ...message, key: { ...message.key, remoteJid: '12345@g.us' } },
        message,
      ],
    });
    await vi.waitFor(() => expect(options.receive).toHaveBeenCalledOnce());
    expect(options.receive).toHaveBeenCalledWith({
      id: 'inbound1',
      sender: '12345@s.whatsapp.net',
      conversation: '12345@s.whatsapp.net',
      text: 'Hello',
    });
    await expect(client.send('12345@s.whatsapp.net', 'Hello')).rejects.toMatchObject({
      delivery: 'not_sent',
    });
    emit('connection.update', { connection: 'open' });
    await expect(client.send('12345@s.whatsapp.net', 'Hello')).resolves.toEqual({
      id: 'sent-message',
    });
    await client.close();
  });
});
