import { describe, expect, it } from 'vitest';
import { voiceWav } from '@sazuz/llm';
import { encodeVoiceWav, toBase64 } from './voice-audio';
describe('browser microphone encoding', () => {
  it('produces server-valid mono PCM and clips samples without wrapping them', () => {
    const output = encodeVoiceWav(new Float32Array([-2, -1, 0, 1, 2]));
    const view = new DataView(output.buffer);
    expect(voiceWav(output).seconds).toBe(5 / 16000);
    expect([44, 46, 48, 50, 52].map((offset) => view.getInt16(offset, true))).toEqual([
      -32768, -32768, 0, 32767, 32767,
    ]);
    expect(Buffer.from(toBase64(output), 'base64')).toEqual(Buffer.from(output));
  });
  it('refuses empty, overlong and non-finite microphone buffers', () => {
    for (const samples of [new Float32Array(), new Float32Array(480001), new Float32Array([NaN])])
      expect(() => encodeVoiceWav(samples)).toThrow();
  });
});
