import { describe, expect, it } from 'vitest';
import { SecretRedactor } from '@sazuz/vault';
import { remember, scrub } from './session.js';

describe('bounded session redaction', () => {
  it('withholds all text if a credential cannot fit in the redaction corpus', () => {
    const session = {
      redactions: new Set<string>(),
      redactor: new SecretRedactor(),
      opaque: false,
      sensitive: false,
    };
    remember(session, 'long-cookie-value'.repeat(600));
    expect(session.sensitive).toBe(true);
    expect(scrub(session, 'potentially sensitive page text', 100)).toBe(
      '[Sensitive content withheld]',
    );
  });
});
