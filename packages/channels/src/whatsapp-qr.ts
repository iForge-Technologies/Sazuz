import {
  makeWASocket,
  initAuthCreds,
  BufferJSON,
  proto,
  DisconnectReason,
  type AuthenticationCreds,
  type SignalDataTypeMap,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { z } from 'zod';
import { ChannelError, inboundSchema, type ChannelInbound } from './gateways.js';

export interface QrAuthStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string | null): Promise<void>;
  clear(): Promise<void>;
}
export interface QrStatus {
  state: 'connecting' | 'qr' | 'connected' | 'disconnected' | 'error';
  qr: string | null;
  expiresAt: string | null;
}

/** Optional unofficial linked-device transport. Authentication never uses filesystem state. */
export async function connectWhatsAppQr(options: {
  storage: QrAuthStorage;
  receive: (event: ChannelInbound) => Promise<void>;
  onError: () => void;
}) {
  const stored = await options.storage.read('creds');
  const decode = (text: string): unknown => {
    if (text.length > 65_536) throw new ChannelError('PAYLOAD_INVALID');
    return JSON.parse(text, BufferJSON.reviver) as unknown;
  };
  const value = stored ? decode(stored) : initAuthCreds();
  const keyPair = z.object({ public: z.instanceof(Uint8Array), private: z.instanceof(Uint8Array) });
  z.object({
    noiseKey: keyPair,
    signedIdentityKey: keyPair,
    signedPreKey: z.object({ keyPair }),
    registrationId: z.number().int(),
    advSecretKey: z.string(),
    registered: z.boolean(),
  }).parse(value);
  // Vendor-owned credential fields are generated locally and stored only through the vault adapter.
  const creds = value as AuthenticationCreds;
  let status: QrStatus = { state: 'connecting', qr: null, expiresAt: null };
  let socket: WASocket | undefined;
  let stopped = false;
  let retry = 0;
  let timer: NodeJS.Timeout | undefined;
  let writes = Promise.resolve();
  const save = (key: string, data: unknown) => {
    if (stopped) return Promise.resolve();
    const serialized = data === null ? null : JSON.stringify(data, BufferJSON.replacer);
    if (serialized && serialized.length > 65_536)
      return Promise.reject(new ChannelError('PAYLOAD_INVALID'));
    const next = writes.then(() => options.storage.write(key, serialized));
    writes = next.catch(() => {
      fail();
    });
    return next;
  };
  function fail() {
    status = { state: 'error', qr: null, expiresAt: null };
    options.onError();
    stopped = true;
    if (timer) clearTimeout(timer);
    void socket?.end(undefined).catch(options.onError);
  }
  const safe = (operation: Promise<void>) => {
    void operation.catch(fail);
  };
  function open() {
    socket = makeWASocket({
      auth: {
        creds,
        keys: {
          async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
            const result: Record<string, SignalDataTypeMap[T]> = {};
            for (const id of ids) {
              const saved = await options.storage.read(`${type}:${id}`);
              if (!saved) continue;
              let data = decode(saved);
              if (type === 'app-state-sync-key')
                data = proto.Message.AppStateSyncKeyData.fromObject(
                  z.record(z.string(), z.unknown()).parse(data),
                );
              result[id] = data as SignalDataTypeMap[T];
            }
            return result;
          },
          async set(data) {
            for (const [kind, entries] of Object.entries(data))
              for (const [id, entry] of Object.entries(entries ?? {}))
                await save(`${kind}:${id}`, entry);
          },
        },
      },
      logger: pino({ level: 'silent' }),
      browser: ['Sazuz', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      shouldSyncHistoryMessage: () => false,
      connectTimeoutMs: 20_000,
      defaultQueryTimeoutMs: 15_000,
    });
    const active = socket;
    socket.ev.on('creds.update', (update) => {
      if (stopped || socket !== active) return;
      Object.assign(creds, update);
      safe(save('creds', creds));
    });
    socket.ev.on('connection.update', (update) =>
      safe(
        (async () => {
          if (stopped || socket !== active) return;
          if (update.qr) {
            const qr = await QRCode.toDataURL(update.qr, { width: 280, margin: 2 });
            if (stopped || socket !== active) return;
            status = {
              state: 'qr',
              qr,
              expiresAt: new Date(Date.now() + 45_000).toISOString(),
            };
          }
          if (update.connection === 'open') {
            retry = 0;
            status = { state: 'connected', qr: null, expiresAt: null };
            await save('creds', creds);
          }
          if (update.connection === 'close') {
            status = { state: 'disconnected', qr: null, expiresAt: null };
            const error = update.lastDisconnect?.error;
            const code = z
              .object({ output: z.object({ statusCode: z.number() }) })
              .safeParse(error);
            if (
              code.success &&
              code.data.output.statusCode === Number(DisconnectReason.loggedOut)
            ) {
              stopped = true;
              if (timer) clearTimeout(timer);
              await writes;
              await options.storage.clear();
              return;
            }
            if (retry >= 6) {
              fail();
              return;
            }
            if (timer) clearTimeout(timer);
            status = { state: 'connecting', qr: null, expiresAt: null };
            timer = setTimeout(
              () => {
                if (!stopped) {
                  try {
                    open();
                  } catch {
                    fail();
                  }
                }
              },
              Math.min(30_000, 1000 * 2 ** retry++),
            );
            timer.unref();
          }
        })(),
      ),
    );
    socket.ev.on('messages.upsert', ({ messages, type }) =>
      safe(
        (async () => {
          if (type !== 'notify' || stopped || socket !== active) return;
          for (const message of messages) {
            if (message.key.fromMe) continue;
            const jid = message.key.remoteJidAlt ?? message.key.remoteJid;
            if (!jid || !/^\d+@(?:s\.whatsapp\.net|lid)$/.test(jid)) continue;
            const text =
              message.message?.conversation ?? message.message?.extendedTextMessage?.text;
            const event = inboundSchema.safeParse({
              id: message.key.id,
              sender: jid,
              conversation: jid,
              text,
            });
            if (event.success) await options.receive(event.data);
          }
        })(),
      ),
    );
  }
  open();
  return {
    status(): QrStatus {
      return status.expiresAt && Date.parse(status.expiresAt) < Date.now()
        ? { ...status, qr: null, expiresAt: null }
        : { ...status };
    },
    async send(conversation: string, text: string) {
      if (
        status.state !== 'connected' ||
        stopped ||
        !/^\d+@(?:s\.whatsapp\.net|lid)$/.test(conversation) ||
        text.length > 8000
      )
        throw new ChannelError('CHANNEL_UNAVAILABLE', 'not_sent');
      try {
        const result = await socket!.sendMessage(conversation, { text });
        return { id: z.string().min(1).parse(result?.key.id) };
      } catch {
        throw new ChannelError('DELIVERY_FAILED');
      }
    },
    async close(logout = false) {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (logout && socket) {
        try {
          await socket.logout();
        } catch {
          options.onError();
        }
      }
      try {
        await socket?.end(undefined);
      } catch {
        options.onError();
      }
      await writes;
      if (logout) await options.storage.clear();
      status = { state: 'disconnected', qr: null, expiresAt: null };
    },
  };
}
