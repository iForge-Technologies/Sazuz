import { z } from 'zod';

const telegramId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const user = z.object({ id: telegramId, is_bot: z.boolean().optional() });
const chat = z.object({
  id: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  type: z.enum(['private', 'group', 'supergroup', 'channel']),
});
const message = z.object({
  message_id: z.number().int().positive(),
  from: user.optional(),
  chat,
  text: z.string().max(16384).optional(),
});

export const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  message: message.optional(),
  callback_query: z
    .object({
      id: z.string().min(1).max(256),
      from: user,
      message: message.optional(),
      data: z.string().max(64).optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export const telegramPairingSchema = z
  .strictObject({
    userId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128),
    senderId: z.string().regex(/^[1-9]\d{0,15}$/),
    chatId: z.string().regex(/^[1-9]\d{0,15}$/),
  })
  .refine((pairing) => pairing.senderId === pairing.chatId);
export type TelegramPairing = z.infer<typeof telegramPairingSchema>;

const button = z.union([
  z.strictObject({
    text: z.string().min(1).max(64),
    callback_data: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= 64),
  }),
  z.strictObject({
    text: z.string().min(1).max(64),
    url: z
      .url()
      .max(2048)
      .refine((value) => {
        const target = new URL(value);
        return (
          ['https:', 'http:'].includes(target.protocol) && !target.username && !target.password
        );
      }),
  }),
]);
export const telegramReplyMarkupSchema = z.strictObject({
  inline_keyboard: z.array(z.array(button).min(1).max(3)).min(1).max(10),
});
export type TelegramReplyMarkup = z.infer<typeof telegramReplyMarkupSchema>;

export type TelegramAuditKind =
  | 'invalid_update'
  | 'unsupported_update'
  | 'unpaired_sender'
  | 'pairing_rejected'
  | 'paired'
  | 'invalid_callback'
  | 'approval_rejected'
  | 'duplicate_callback';
export interface TelegramAuditEvent {
  kind: TelegramAuditKind;
  updateId?: number;
  senderId?: string;
  chatId?: string;
}

export interface TelegramHandlerDependencies {
  pair: (input: {
    codeHash: string;
    senderId: string;
    chatId: string;
  }) => Promise<TelegramPairing | null>;
  lookup: (input: { senderId: string; chatId: string }) => Promise<TelegramPairing | null>;
  consumeUpdate: (updateId: number) => Promise<boolean>;
  consumeCallback: (callbackId: string) => Promise<boolean>;
  audit: (event: TelegramAuditEvent) => Promise<void>;
  mission: (input: {
    pairing: TelegramPairing;
    text: string;
    idempotencyKey: string;
  }) => Promise<string>;
  status: (pairing: TelegramPairing) => Promise<string>;
  stop: (pairing: TelegramPairing) => Promise<string>;
  digest: (pairing: TelegramPairing) => Promise<string>;
  decideApproval: (input: {
    pairing: TelegramPairing;
    approvalId: string;
    version: number;
    decision: 'approve' | 'deny';
    callbackId: string;
  }) => Promise<'accepted' | 'stale' | 'denied'>;
  reply: (pairing: TelegramPairing, text: string) => Promise<void>;
  answerCallback: (callbackId: string, text: string) => Promise<void>;
}

export type TelegramHandleResult = {
  status: 'ignored' | 'duplicate' | 'paired' | 'mission' | 'command' | 'approval';
  updateId?: number;
};

export type ChannelErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_CREDENTIAL'
  | 'INVALID_RESPONSE'
  | 'REQUEST_REJECTED'
  | 'TRANSPORT_FAILED'
  | 'CANCELLED'
  | 'HANDLER_FAILED';

/** A failed outbound call is uncertain unless it was rejected before delivery. */
export class TelegramError extends Error {
  constructor(
    public readonly code: ChannelErrorCode,
    public readonly delivery: 'not_sent' | 'unknown' = 'unknown',
  ) {
    super('The Telegram operation could not be completed.');
    this.name = 'TelegramError';
  }
}
