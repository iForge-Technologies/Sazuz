import { describe, expect, it, vi } from 'vitest';
import { createSpeechAdapter, voiceWav } from './speech.js';

const provider = {
  id: 'speech',
  name: 'Speech',
  kind: 'openai-compatible' as const,
  baseUrl: 'http://localhost:8080/v1',
  locality: 'local' as const,
  enabled: true,
  secretRef: null,
};
function wav() {
  const audio = Buffer.alloc(32044);
  Buffer.from(
    '52494646247d000057415645666d74201000000001000100803e0000007d00000200100064617461007d0000',
    'hex',
  ).copy(audio);
  return audio;
}
describe('bounded provider-neutral speech', () => {
  it('measures canonical PCM and refuses duration smuggling, compressed audio and malformed headers', () => {
    expect(voiceWav(wav())).toEqual({ seconds: 1 });
    for (const audio of [
      Buffer.alloc(0),
      Buffer.concat([wav(), Buffer.alloc(2)]),
      Buffer.alloc(960046),
    ])
      expect(() => voiceWav(audio)).toThrow();
    for (const offset of [0, 4, 8, 16, 20, 22, 24, 28, 32, 34, 36, 40]) {
      const audio = wav();
      audio[offset] = audio[offset]! ^ 1;
      expect(() => voiceWav(audio)).toThrow();
    }
  });
  it('uses the official compatible multipart route without retries or credential redirects', async () => {
    const secret = 'voice-provider-secret-canary-198274';
    const transport = vi.fn<typeof fetch>((url, init) => {
      expect(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).toBe(
        'http://localhost:8080/v1/audio/transcriptions',
      );
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
      expect(init?.body).toBeInstanceOf(FormData);
      return Promise.resolve(
        Response.json({ text: `Hello ${secret}`, language: 'en', duration: 1, segments: [] }),
      );
    });
    const adapter = createSpeechAdapter({
      fetch: transport,
      resolveSecret: (_ref, consume) => consume(secret),
    });
    const output = await adapter.transcribe(
      {
        provider: { ...provider, secretRef: 'secret://sec_01J00000000000000000000000' },
        modelId: 'tiny.en',
        privateOnly: true,
      },
      wav(),
      AbortSignal.timeout(1000),
    );
    expect(output).toContain('Hello');
    expect(output).not.toContain(secret);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects cloud/private routing, unsupported providers and secret-bearing spoken text before dispatch', async () => {
    const transport = vi.fn<typeof fetch>();
    const adapter = createSpeechAdapter({
      fetch: transport,
      resolveSecret: (_ref, consume) => consume('speech-secret-before-call-27593'),
    });
    await expect(
      adapter.transcribe(
        { provider: { ...provider, locality: 'cloud' }, modelId: 'tiny.en', privateOnly: true },
        wav(),
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_AVAILABLE' });
    await expect(
      adapter.transcribe(
        { provider: { ...provider, kind: 'anthropic' }, modelId: 'tiny.en', privateOnly: false },
        wav(),
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_AVAILABLE' });
    await expect(
      adapter.speak(
        {
          provider: { ...provider, secretRef: 'secret://sec_01J00000000000000000000000' },
          modelId: 'tts',
          privateOnly: false,
        },
        'speech-secret-before-call-27593',
        'voice',
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('returns only bounded WAV output and sanitizes provider failures without retries', async () => {
    const transport = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(wav(), { headers: { 'content-type': 'audio/wav' } })),
    );
    const adapter = createSpeechAdapter({
      fetch: transport,
      resolveSecret: (_ref, consume) => consume(''),
    });
    expect(
      (
        await adapter.speak(
          { provider, modelId: 'tts', privateOnly: true },
          'Hello.',
          'voice',
          AbortSignal.timeout(1000),
        )
      ).length,
    ).toBe(32044);
    transport.mockResolvedValueOnce(
      Response.json({ error: { message: 'private-provider-error-canary' } }, { status: 503 }),
    );
    await expect(
      adapter.transcribe(
        { provider, modelId: 'tiny.en', privateOnly: true },
        wav(),
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({
      message: 'The model provider is unavailable. Check its connection and model.',
    });
    expect(transport).toHaveBeenCalledTimes(2);
    transport.mockResolvedValueOnce(new Response(Buffer.alloc(4_194_305)));
    await expect(
      adapter.speak(
        { provider, modelId: 'tts', privateOnly: true },
        'Hello.',
        'voice',
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow();
  });
});
