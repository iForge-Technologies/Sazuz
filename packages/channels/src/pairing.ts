import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { TelegramError, telegramReplyMarkupSchema, type TelegramReplyMarkup } from './contracts.js';

/** Persist only codeHash with user/project binding; compare and consume atomically before expiry. */
export function createTelegramPairingCode(
  now = new Date(),
  ttlMs = 10 * 60_000,
): { code: string; codeHash: string; expiresAt: string } {
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isInteger(ttlMs) ||
    ttlMs < 1000 ||
    ttlMs > 15 * 60_000
  )
    throw new TelegramError('INVALID_ARGUMENT', 'not_sent');
  const code = randomBytes(18).toString('base64url');
  return {
    code,
    codeHash: hashTelegramPairingCode(code),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

export function hashTelegramPairingCode(code: string): string {
  if (!/^[A-Za-z0-9_-]{24}$/.test(code)) throw new TelegramError('INVALID_ARGUMENT', 'not_sent');
  return createHash('sha256').update(code).digest('hex');
}

const approvalIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

export function telegramApprovalButtons(input: {
  approvalId: string;
  version: number;
  viewUrl?: string;
}): TelegramReplyMarkup {
  const parsed = z
    .strictObject({
      approvalId: approvalIdSchema,
      version: z.number().int().positive().max(2147483647),
      viewUrl: z.string().optional(),
    })
    .safeParse(input);
  if (!parsed.success) throw new TelegramError('INVALID_ARGUMENT', 'not_sent');
  const { approvalId, version, viewUrl } = parsed.data;
  const prefix = `a:${approvalId}:${version.toString(36)}`;
  const buttons = [
    { text: 'Approve', callback_data: `${prefix}:y` },
    { text: 'Deny', callback_data: `${prefix}:n` },
    ...(viewUrl === undefined ? [] : [{ text: 'View', url: viewUrl }]),
  ];
  const markup = telegramReplyMarkupSchema.safeParse({ inline_keyboard: [buttons] });
  if (!markup.success) throw new TelegramError('INVALID_ARGUMENT', 'not_sent');
  return markup.data;
}

export function parseTelegramApprovalCallback(
  data: string,
): { approvalId: string; version: number; decision: 'approve' | 'deny' } | null {
  if (Buffer.byteLength(data, 'utf8') > 64) return null;
  const parts = /^a:([A-Za-z0-9_-]{1,40}):([1-9a-z][0-9a-z]{0,5}):([yn])$/.exec(data);
  if (parts === null) return null;
  const version = Number.parseInt(parts[2]!, 36);
  if (version > 2147483647 || version < 1 || version.toString(36) !== parts[2]) return null;
  return { approvalId: parts[1]!, version, decision: parts[3] === 'y' ? 'approve' : 'deny' };
}
