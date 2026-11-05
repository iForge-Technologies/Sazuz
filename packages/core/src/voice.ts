import { z } from 'zod';
import { workId } from './work';

export const MAX_VOICE_SECONDS = 30;
export const MAX_VOICE_BYTES = 44 + 16000 * 2 * MAX_VOICE_SECONDS;
export const MAX_SPOKEN_CHARACTERS = 4000;
const audio = z
  .string()
  .max(Math.ceil(MAX_VOICE_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const transcribeInputSchema = z.strictObject({
  requestId: z.uuid(),
  speechVersion: z.number().int().positive(),
  providersVersion: z.number().int().positive(),
  projectId: workId,
  audio,
  consent: z.literal(true),
});
export const speakInputSchema = z.strictObject({
  requestId: z.uuid(),
  speechVersion: z.number().int().positive(),
  providersVersion: z.number().int().positive(),
  messageId: workId,
  consent: z.literal(true),
});
export const speechReceiptSchema = z.strictObject({
  id: workId,
  kind: z.enum(['transcribe', 'speak']),
  status: z.enum(['intent', 'done', 'uncertain']),
  projectId: workId,
  providerId: z.string().max(64),
  modelId: z.string().max(200),
  costUsd: z.number().finite().nonnegative(),
  estimated: z.literal(true),
  transcript: z.string().max(12000).nullable(),
  createdAt: z.iso.datetime(),
});
export const speechResultSchema = z.strictObject({
  receipt: speechReceiptSchema,
  audio: z
    .string()
    .max(5_600_000)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .nullable(),
  mediaType: z.literal('audio/wav').nullable(),
});
export class VoiceError extends Error {
  constructor(
    readonly code:
      | 'VOICE_INVALID'
      | 'VOICE_UNAVAILABLE'
      | 'VOICE_NOT_FOUND'
      | 'VOICE_CONFLICT'
      | 'VOICE_DENIED'
      | 'VOICE_BUSY'
      | 'VOICE_BUDGET',
  ) {
    super(
      {
        VOICE_INVALID:
          'Use a recording of at most 30 seconds or an assistant message of at most 4,000 characters.',
        VOICE_UNAVAILABLE:
          'Speech is unavailable. Check Speech settings, the provider and the vault.',
        VOICE_NOT_FOUND: 'This speech request or message is unavailable.',
        VOICE_CONFLICT:
          'Speech settings changed or this request identifier was already used. Reload and check Speech history before trying again.',
        VOICE_DENIED: 'Current policy or privacy settings do not permit this speech request.',
        VOICE_BUSY: 'Another model request is using the budget. Try again shortly.',
        VOICE_BUDGET: 'This speech request exceeds the available budget.',
      }[code],
    );
    this.name = 'VoiceError';
  }
}
