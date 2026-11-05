import { describe, expect, it } from 'vitest';
import { SecretRedactor } from './redaction.js';

describe('incremental model redaction', () => {
  it('streams ordinary prose before the response has ended', () => {
    const stream = new SecretRedactor().createStream();
    expect(stream.push('The answer ')).toBe('The answer ');
    expect(stream.push('is 42.')).toBe('is ');
    expect(stream.finish()).toBe('42.');
  });

  it.each([
    'multi word\ncanary with spaces',
    'sk-canary-secret-123456789123456789',
    'url:@canary/value +encoded',
    'quote"and\\backslash',
  ])('never exposes a registered credential split at any boundary: %s', (secret) => {
    const redactor = new SecretRedactor();
    redactor.register(secret);
    for (const variant of [
      secret,
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
    ]) {
      const text = `Before ${variant} after.`;
      for (let cut = 0; cut <= text.length; cut += 1) {
        const stream = redactor.createStream();
        const first = stream.push(text.slice(0, cut));
        const result = first + stream.push(text.slice(cut)) + stream.finish();
        expect(result).toBe('Before [REDACTED] after.');
        expect(first).not.toContain(variant);
      }
    }
  });

  it.each([
    'prefix api_key="unknown key with spaces" suffix',
    'prefix password = secret-value suffix',
    'prefix Bearer unknown-token.value suffix',
    'Authorization: Bearer token with extra text\nsuffix',
    'prefix https://user:password@example.test/path suffix',
    'prefix sk-abcdefgh1234567891011 suffix',
    'prefix -----BEGIN PRIVATE KEY-----\nkey material\n-----END PRIVATE KEY----- suffix',
  ])('scrubs structural credentials under one-character streaming: %s', (input) => {
    const redactor = new SecretRedactor();
    const stream = redactor.createStream();
    let result = '';
    for (const character of input) result += stream.push(character);
    result += stream.finish();
    expect(result).toBe(redactor.redactText(input));
  });

  it('discards held text after failure and refuses accidental stream reuse', () => {
    const stream = new SecretRedactor().createStream();
    expect(stream.push('password="partial')).toBe('');
    stream.discard();
    expect(() => stream.push('value"')).toThrow();
    expect(() => stream.finish()).toThrow();
  });
});
