/** Fixed 16 kHz, mono, signed 16-bit PCM; the server validates this exact header and duration. */
export function encodeVoiceWav(samples: Float32Array): Uint8Array<ArrayBuffer> {
  if (
    !samples.length ||
    samples.length > 480000 ||
    samples.some((sample) => !Number.isFinite(sample))
  )
    throw new Error('Record between a moment and 30 seconds of audio.');
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}
export const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};
export async function normalizeVoice(blob: Blob, context: AudioContext) {
  if (blob.size > 8_000_000) throw new Error('The recording is too large.');
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  const length = Math.min(480000, Math.round(decoded.duration * 16000));
  const renderer = new OfflineAudioContext(1, Math.max(1, length), 16000);
  const source = renderer.createBufferSource();
  source.buffer = decoded;
  source.connect(renderer.destination);
  source.start();
  return encodeVoiceWav((await renderer.startRendering()).getChannelData(0));
}
