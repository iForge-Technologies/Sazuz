import { z } from 'zod';
import { createSpeechService } from '@sazuz/runtime';
import {
  speakInputSchema,
  speechReceiptSchema,
  speechResultSchema,
  transcribeInputSchema,
} from '@sazuz/core/voice';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { emptyRequest } from './phase-three-shared.js';

export function registerVoice(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  options: { fetch?: typeof fetch } = {},
) {
  const speech = createSpeechService({
    database: runtime.database,
    vault: runtime.vault,
    ...options,
  });
  app.get(
    '/api/voice',
    {
      schema: {
        querystring: emptyRequest,
        response: { 200: z.array(speechReceiptSchema).max(30) },
      },
    },
    async (request) => speech.history((await runtime.admin(request)).user.id),
  );
  app.post(
    '/api/voice/transcribe',
    {
      bodyLimit: 1_300_000,
      schema: { body: transcribeInputSchema, response: { 200: speechResultSchema } },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      await runtime.rateLimit(`voice:${user.id}`, 12);
      request.raw.socket?.setTimeout?.(65000);
      return speech.transcribe(user.id, request.body);
    },
  );
  app.post(
    '/api/voice/speak',
    { schema: { body: speakInputSchema, response: { 200: speechResultSchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      await runtime.rateLimit(`voice:${user.id}`, 12);
      request.raw.socket?.setTimeout?.(65000);
      return speech.speak(user.id, request.body);
    },
  );
  return speech;
}
