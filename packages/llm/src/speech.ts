import { transcribe, generateSpeech } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { providerSchema } from '@sazuz/config/settings';
import { secretRedactor } from '@sazuz/vault';
import { providerBaseUrl, restrictedProviderFetch } from './providers.js';
import { ModelError } from './errors.js';

/** Canonical PCM has no compressed-duration ambiguity, metadata chunks, or hidden trailing audio. */
export function voiceWav(bytes: Uint8Array) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    b.length < 46 ||
    b.length > 960044 ||
    b.toString('ascii', 0, 4) !== 'RIFF' ||
    b.readUInt32LE(4) !== b.length - 8 ||
    b.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
    b.readUInt32LE(16) !== 16 ||
    b.readUInt16LE(20) !== 1 ||
    b.readUInt16LE(22) !== 1 ||
    b.readUInt32LE(24) !== 16000 ||
    b.readUInt32LE(28) !== 32000 ||
    b.readUInt16LE(32) !== 2 ||
    b.readUInt16LE(34) !== 16 ||
    b.toString('ascii', 36, 40) !== 'data' ||
    b.readUInt32LE(40) !== b.length - 44 ||
    (b.length - 44) % 2 !== 0
  )
    throw new ModelError('MODEL_INVALID_INPUT');
  return { seconds: (b.length - 44) / 32000 };
}

const requestSchema = z.strictObject({
  provider: providerSchema,
  modelId: z.string().trim().min(1).max(200),
  privateOnly: z.boolean(),
});
export type SpeechAdapterOptions = {
  resolveSecret: <T>(reference: string, consume: (secret: string) => Promise<T>) => Promise<T>;
  fetch?: typeof fetch;
};
export type SpeechSelection = z.infer<typeof requestSchema>;

/** Provider-specific speech protocol stays inside the model adapter. No SDK retries or telemetry. */
export function createSpeechAdapter(options: SpeechAdapterOptions) {
  async function invoke<T>(
    selection: SpeechSelection,
    signal: AbortSignal,
    use: (provider: ReturnType<typeof createOpenAI>) => Promise<T>,
  ) {
    const input = requestSchema.parse(selection);
    if (
      !input.provider.enabled ||
      (input.privateOnly && input.provider.locality !== 'local') ||
      !['openai', 'openai-compatible', 'other'].includes(input.provider.kind)
    )
      throw new ModelError('MODEL_NOT_AVAILABLE');
    const restricted = restrictedProviderFetch(
      options.fetch ?? fetch,
      new URL(input.provider.baseUrl).origin,
    );
    const bounded: typeof fetch = async (url, init) => {
      const response = await restricted(url, { ...init, signal });
      if (!response.body) throw new ModelError('PROVIDER_INVALID_RESPONSE');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          const chunk = z.instanceof(Uint8Array).parse(item.value);
          length += chunk.byteLength;
          if (length > 4_194_304) throw new ModelError('PROVIDER_INVALID_RESPONSE');
          chunks.push(chunk);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      return new Response(Buffer.concat(chunks), {
        status: response.status,
        headers: response.headers,
      });
    };
    const execute = async (key: string) => {
      if (key) secretRedactor.register(key);
      return use(
        createOpenAI({ baseURL: providerBaseUrl(input.provider), apiKey: key, fetch: bounded }),
      );
    };
    try {
      return input.provider.secretRef
        ? await options.resolveSecret(input.provider.secretRef, execute)
        : await execute('');
    } catch (error) {
      if (error instanceof ModelError) throw error;
      throw new ModelError('PROVIDER_UNAVAILABLE');
    }
  }
  return {
    async transcribe(selection: SpeechSelection, audio: Uint8Array, signal: AbortSignal) {
      voiceWav(audio);
      return invoke(selection, signal, async (provider) => {
        const result = await transcribe({
          model: provider.transcription(selection.modelId),
          audio,
          maxRetries: 0,
          abortSignal: signal,
        });
        return z.string().trim().min(1).max(12000).parse(secretRedactor.redactText(result.text));
      });
    },
    async speak(selection: SpeechSelection, text: string, voice: string, signal: AbortSignal) {
      return invoke(selection, signal, async (provider) => {
        if (
          !z.string().min(1).max(4000).safeParse(text).success ||
          secretRedactor.redactText(text) !== text
        )
          throw new ModelError('MODEL_INVALID_INPUT');
        const result = await generateSpeech({
          model: provider.speech(selection.modelId),
          text,
          voice: z.string().min(1).max(100).parse(voice),
          outputFormat: 'wav',
          maxRetries: 0,
          abortSignal: signal,
        });
        const audio = Buffer.from(result.audio.uint8Array);
        if (
          audio.length < 44 ||
          audio.length > 4_194_304 ||
          audio.toString('ascii', 0, 4) !== 'RIFF' ||
          audio.toString('ascii', 8, 12) !== 'WAVE'
        )
          throw new ModelError('PROVIDER_INVALID_RESPONSE');
        return audio;
      });
    },
  };
}
