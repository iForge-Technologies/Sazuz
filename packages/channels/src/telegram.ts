import { secretRedactor } from '@sazuz/vault';
import { z } from 'zod';
import {
  TelegramError,
  telegramPairingSchema,
  telegramReplyMarkupSchema,
  telegramUpdateSchema,
  type TelegramHandlerDependencies,
  type TelegramHandleResult,
  type TelegramPairing,
  type TelegramReplyMarkup,
  type TelegramUpdate,
} from './contracts.js';
import { hashTelegramPairingCode, parseTelegramApprovalCallback } from './pairing.js';

const safeReply = (value: string): string => secretRedactor.redactText(value).slice(0, 4096);

function validPairing(
  value: TelegramPairing | null,
  senderId: string,
  chatId: string,
): TelegramPairing | null {
  const parsed = telegramPairingSchema.safeParse(value);
  return parsed.success && parsed.data.senderId === senderId && parsed.data.chatId === chatId
    ? parsed.data
    : null;
}

export function createTelegramHandler(dependencies: TelegramHandlerDependencies): {
  handle(update: unknown): Promise<TelegramHandleResult>;
} {
  return {
    async handle(value) {
      const parsed = telegramUpdateSchema.safeParse(value);
      if (!parsed.success) {
        await dependencies.audit({ kind: 'invalid_update' });
        return { status: 'ignored' };
      }
      const update = parsed.data;
      try {
        if (!(await dependencies.consumeUpdate(update.update_id)))
          return { status: 'duplicate', updateId: update.update_id };
        const source = update.callback_query ?? update.message;
        const sender = source?.from;
        const chat = update.callback_query?.message?.chat ?? update.message?.chat;
        if (
          sender === undefined ||
          chat?.type !== 'private' ||
          sender.is_bot === true ||
          sender.id !== chat.id
        ) {
          await dependencies.audit({ kind: 'unsupported_update', updateId: update.update_id });
          return { status: 'ignored', updateId: update.update_id };
        }
        const senderId = String(sender.id);
        const chatId = String(chat.id);
        const text = update.message?.text?.trim() ?? '';
        const pairRequest = /^\/(?:pair|start)(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{24})$/.exec(
          text,
        );
        if (update.callback_query === undefined && pairRequest !== null) {
          const pairing = validPairing(
            await dependencies.pair({
              codeHash: hashTelegramPairingCode(pairRequest[1]!),
              senderId,
              chatId,
            }),
            senderId,
            chatId,
          );
          if (pairing === null) {
            await dependencies.audit({
              kind: 'pairing_rejected',
              updateId: update.update_id,
              senderId,
              chatId,
            });
            return { status: 'ignored', updateId: update.update_id };
          }
          await dependencies.audit({
            kind: 'paired',
            updateId: update.update_id,
            senderId,
            chatId,
          });
          await dependencies.reply(
            pairing,
            'Paired. Send a task, or use /status, /stop, or /digest.',
          );
          return { status: 'paired', updateId: update.update_id };
        }
        const pairing = validPairing(
          await dependencies.lookup({ senderId, chatId }),
          senderId,
          chatId,
        );
        if (pairing === null) {
          await dependencies.audit({
            kind: 'unpaired_sender',
            updateId: update.update_id,
            senderId,
            chatId,
          });
          return { status: 'ignored', updateId: update.update_id };
        }
        if (update.callback_query !== undefined) {
          const callback = update.callback_query;
          if (!(await dependencies.consumeCallback(callback.id))) {
            await dependencies.audit({
              kind: 'duplicate_callback',
              updateId: update.update_id,
              senderId,
              chatId,
            });
            return { status: 'duplicate', updateId: update.update_id };
          }
          const action = parseTelegramApprovalCallback(callback.data ?? '');
          if (action === null) {
            await dependencies.audit({
              kind: 'invalid_callback',
              updateId: update.update_id,
              senderId,
              chatId,
            });
            await dependencies.answerCallback(callback.id, 'This approval button is invalid.');
            return { status: 'ignored', updateId: update.update_id };
          }
          // This repository transaction must verify ownership, exact version, arguments and expiry,
          // and atomically enqueue the paused run. A paired sender alone does not grant approval.
          const result = await dependencies.decideApproval({
            pairing,
            ...action,
            callbackId: callback.id,
          });
          if (result !== 'accepted')
            await dependencies.audit({
              kind: 'approval_rejected',
              updateId: update.update_id,
              senderId,
              chatId,
            });
          await dependencies.answerCallback(
            callback.id,
            result === 'accepted'
              ? action.decision === 'approve'
                ? 'Approved.'
                : 'Denied.'
              : 'This approval is no longer available.',
          );
          return {
            status: result === 'accepted' ? 'approval' : 'ignored',
            updateId: update.update_id,
          };
        }
        if (!text) return { status: 'ignored', updateId: update.update_id };
        const command = /^\/(status|stop|digest|start)(?:@[A-Za-z0-9_]+)?\s*$/.exec(text)?.[1];
        if (command !== undefined) {
          const response =
            command === 'status'
              ? await dependencies.status(pairing)
              : command === 'stop'
                ? await dependencies.stop(pairing)
                : command === 'digest'
                  ? await dependencies.digest(pairing)
                  : 'Send a task, or use /status, /stop, or /digest.';
          await dependencies.reply(pairing, safeReply(response));
          return { status: 'command', updateId: update.update_id };
        }
        if (text.startsWith('/')) {
          await dependencies.reply(
            pairing,
            'Commands: /status, /stop, /digest. Send plain text to start a task.',
          );
          return { status: 'command', updateId: update.update_id };
        }
        const response = await dependencies.mission({
          pairing,
          text: safeReply(text),
          idempotencyKey: `telegram:${update.update_id}`,
        });
        await dependencies.reply(pairing, safeReply(response));
        return { status: 'mission', updateId: update.update_id };
      } catch (error) {
        if (error instanceof TelegramError) throw error;
        throw new TelegramError('HANDLER_FAILED');
      }
    },
  };
}

export interface TelegramClientOptions {
  secretRef: string;
  secret: <T>(reference: string, consume: (secret: string) => Promise<T>) => Promise<T>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface TelegramClient {
  getIdentity(signal?: AbortSignal): Promise<string>;
  getUpdates(input: {
    offset?: number;
    timeoutSeconds?: number;
    signal: AbortSignal;
  }): Promise<TelegramUpdate[]>;
  sendMessage(
    input: { recipient: TelegramPairing; text: string; replyMarkup?: TelegramReplyMarkup },
    signal: AbortSignal,
  ): Promise<{ messageId: number; chatId: string }>;
  answerCallbackQuery(
    input: { callbackId: string; text: string },
    signal: AbortSignal,
  ): Promise<void>;
  verifyDelivery(): { status: 'unknown' };
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new TelegramError('CANCELLED');
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        listener = () => reject(new TelegramError('CANCELLED'));
        signal.addEventListener('abort', listener, { once: true });
      }),
    ]);
  } finally {
    if (listener !== undefined) signal.removeEventListener('abort', listener);
  }
}

async function telegramResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const maximum = 1_048_576;
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    await response.body?.cancel();
    throw new TelegramError('INVALID_RESPONSE');
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader !== undefined) {
    try {
      for (;;) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) throw new TelegramError('INVALID_RESPONSE');
        size += value.byteLength;
        if (size > maximum) throw new TelegramError('INVALID_RESPONSE');
        chunks.push(value);
      }
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export function createTelegramClient(options: TelegramClientOptions): TelegramClient {
  const config = z
    .strictObject({
      secretRef: z.string().regex(/^secret:\/\/[A-Za-z0-9_-]{1,128}$/),
      timeoutMs: z.number().int().min(1).max(60000),
    })
    .safeParse({ secretRef: options.secretRef, timeoutMs: options.timeoutMs ?? 35000 });
  if (!config.success) throw new TelegramError('INVALID_ARGUMENT', 'not_sent');
  const call = async (
    method: 'getMe' | 'getUpdates' | 'sendMessage' | 'answerCallbackQuery',
    body: unknown,
    parentSignal: AbortSignal,
  ): Promise<unknown> => {
    if (parentSignal.aborted) throw new TelegramError('CANCELLED', 'not_sent');
    try {
      return await options.secret(config.data.secretRef, async (value) => {
        if (!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(value))
          throw new TelegramError('INVALID_CREDENTIAL', 'not_sent');
        secretRedactor.register(value);
        if (JSON.stringify(body) !== JSON.stringify(secretRedactor.redact(body)))
          throw new TelegramError('INVALID_ARGUMENT', 'not_sent');
        const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(config.data.timeoutMs)]);
        if (signal.aborted) throw new TelegramError('CANCELLED', 'not_sent');
        const response = await abortable(
          (options.fetch ?? globalThis.fetch)(
            new URL(`https://api.telegram.org/bot${value}/${method}`),
            {
              method: 'POST',
              redirect: 'error',
              signal,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            },
          ),
          signal,
        );
        const envelope = z
          .object({
            ok: z.boolean(),
            result: z.unknown().optional(),
            error_code: z.number().int().optional(),
          })
          .safeParse(await telegramResponse(response, signal));
        if (!envelope.success) throw new TelegramError('INVALID_RESPONSE');
        if (!envelope.data.ok) throw new TelegramError('REQUEST_REJECTED', 'not_sent');
        if (!response.ok || envelope.data.result === undefined)
          throw new TelegramError('INVALID_RESPONSE');
        return envelope.data.result;
      });
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw new TelegramError('TRANSPORT_FAILED');
    }
  };
  return {
    async getIdentity(signal = new AbortController().signal) {
      const result = await call('getMe', {}, signal);
      const bot = z
        .object({
          id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          is_bot: z.literal(true),
        })
        .safeParse(result);
      if (!bot.success) throw new TelegramError('INVALID_RESPONSE');
      return String(bot.data.id);
    },
    async getUpdates(input) {
      const parsed = z
        .strictObject({
          offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
          timeoutSeconds: z.number().int().min(0).max(25).default(20),
        })
        .safeParse({ offset: input.offset, timeoutSeconds: input.timeoutSeconds });
      if (!parsed.success) throw new TelegramError('INVALID_ARGUMENT', 'not_sent');
      const result = await call(
        'getUpdates',
        {
          ...(parsed.data.offset === undefined ? {} : { offset: parsed.data.offset }),
          timeout: parsed.data.timeoutSeconds,
          limit: 100,
          allowed_updates: ['message', 'callback_query'],
        },
        input.signal,
      );
      const updates = z.array(telegramUpdateSchema).max(100).safeParse(result);
      if (!updates.success) throw new TelegramError('INVALID_RESPONSE');
      return updates.data;
    },
    async sendMessage(input, signal) {
      const parsed = z
        .strictObject({
          recipient: telegramPairingSchema,
          text: z.string().min(1).max(4096),
          replyMarkup: telegramReplyMarkupSchema.optional(),
        })
        .safeParse(input);
      if (!parsed.success) throw new TelegramError('INVALID_ARGUMENT', 'not_sent');
      const result = await call(
        'sendMessage',
        {
          chat_id: parsed.data.recipient.chatId,
          text: parsed.data.text,
          ...(parsed.data.replyMarkup === undefined
            ? {}
            : { reply_markup: parsed.data.replyMarkup }),
          link_preview_options: { is_disabled: true },
        },
        signal,
      );
      const message = z
        .object({
          message_id: z.number().int().positive(),
          chat: z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
        })
        .safeParse(result);
      if (!message.success || String(message.data.chat.id) !== parsed.data.recipient.chatId)
        throw new TelegramError('INVALID_RESPONSE');
      return { messageId: message.data.message_id, chatId: String(message.data.chat.id) };
    },
    async answerCallbackQuery(input, signal) {
      const parsed = z
        .strictObject({ callbackId: z.string().min(1).max(256), text: z.string().max(200) })
        .safeParse(input);
      if (!parsed.success) throw new TelegramError('INVALID_ARGUMENT', 'not_sent');
      const result = await call(
        'answerCallbackQuery',
        { callback_query_id: parsed.data.callbackId, text: parsed.data.text },
        signal,
      );
      if (result !== true) throw new TelegramError('INVALID_RESPONSE');
    },
    verifyDelivery: () => ({ status: 'unknown' }),
  };
}
