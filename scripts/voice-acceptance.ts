import { z } from 'zod';
import { createSpeechAdapter } from '../packages/llm/src/speech.js';

if (!process.argv.includes('--run'))
  throw new Error('Run only on an explicitly selected disposable voice stack with --run.');
const urls = z.object({ piper: z.url(), whisper: z.url() }).parse({
  piper: process.env.VOICE_ACCEPTANCE_PIPER_URL ?? 'http://piper:8080/v1',
  whisper: process.env.VOICE_ACCEPTANCE_WHISPER_URL ?? 'http://whisper:8080/v1',
});
const adapter = createSpeechAdapter({
  resolveSecret: () => {
    throw new Error('Local voice acceptance cannot resolve credentials.');
  },
});
const selection = (id: 'piper' | 'whisper', modelId: string) => ({
  provider: {
    id,
    name: id,
    kind: 'openai-compatible' as const,
    baseUrl: urls[id],
    locality: 'local' as const,
    enabled: true,
    secretRef: null,
  },
  modelId,
  privateOnly: true,
});
const started = Date.now();
const spoken = await adapter.speak(
  selection('piper', 'en_US-ljspeech-medium'),
  'Hello. Your local voice is ready. You can review the transcript before sending.',
  'ljspeech',
  AbortSignal.timeout(60000),
);
if (
  spoken.subarray(0, 4).toString() !== 'RIFF' ||
  spoken.subarray(36, 40).toString() !== 'data' ||
  spoken.readUInt16LE(22) !== 1 ||
  spoken.readUInt16LE(34) !== 16 ||
  spoken.length > 4194304
)
  throw new Error('Unexpected local speech output.');
const rate = spoken.readUInt32LE(24),
  samples = (spoken.length - 44) / 2;
const length = Math.min(480000, Math.floor((samples * 16000) / rate));
const pcm = Buffer.alloc(44 + length * 2);
pcm.write('RIFF');
pcm.writeUInt32LE(pcm.length - 8, 4);
pcm.write('WAVEfmt ', 8);
pcm.writeUInt32LE(16, 16);
pcm.writeUInt16LE(1, 20);
pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(16000, 24);
pcm.writeUInt32LE(32000, 28);
pcm.writeUInt16LE(2, 32);
pcm.writeUInt16LE(16, 34);
pcm.write('data', 36);
pcm.writeUInt32LE(length * 2, 40);
for (let i = 0; i < length; i++) {
  const position = (i * rate) / 16000,
    index = Math.floor(position),
    fraction = position - index;
  const left = spoken.readInt16LE(44 + index * 2),
    right = spoken.readInt16LE(44 + Math.min(index + 1, samples - 1) * 2);
  pcm.writeInt16LE(Math.round(left + (right - left) * fraction), 44 + i * 2);
}
const transcript = await adapter.transcribe(
  selection('whisper', 'tiny.en'),
  pcm,
  AbortSignal.timeout(60000),
);
pcm.fill(0);
spoken.fill(0);
if (
  !/local voice/i.test(transcript) ||
  !/ready/i.test(transcript) ||
  !/transcript/i.test(transcript)
)
  throw new Error('Local speech round trip did not recover the fixture sentence.');
process.stdout.write(
  JSON.stringify({
    passed: true,
    syntheticFixture: true,
    seconds: length / 16000,
    durationMs: Date.now() - started,
    transcript,
  }) + '\n',
);
