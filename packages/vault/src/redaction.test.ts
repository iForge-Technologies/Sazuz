import { describe, expect, it } from 'vitest';

import { REDACTED, SecretRedactor, SecretRegistrationError } from './index.js';

describe('SecretRedactor', () => {
  it('removes registered secrets and mixed-case percent encoding without changing surrounding text', () => {
    const redactor = new SecretRedactor();
    const canary = 'canary /:@+?&% ü 593127';
    const encoded = encodeURIComponent(canary).replaceAll('%2F', '%2f');
    redactor.register(canary);

    expect(redactor.redactText(`before ${canary} after ${encoded}`)).toBe(
      `before ${REDACTED} after ${REDACTED}`,
    );
    expect(redactor.redactText(encodeURIComponent(canary).replaceAll('%20', '+'))).toBe(REDACTED);
  });

  it('matches literals, JSON escapes, and overlapping secrets longest first', () => {
    const redactor = new SecretRedactor();
    redactor.register('canary');
    redactor.register('canary.$[suffix]\n"quoted"');
    const input = { output: 'canary.$[suffix]\n"quoted"' };

    expect(redactor.redactText(input.output)).toBe(REDACTED);
    expect(redactor.redactText(JSON.stringify(input))).toBe(JSON.stringify({ output: REDACTED }));
    expect(redactor.redactText('canaryZ canarY')).toBe(`${REDACTED}Z canarY`);
  });

  it('keeps every registration active when later credentials are registered', () => {
    const redactor = new SecretRedactor();
    redactor.register('retired-credential-4921');
    redactor.redactText('force matcher compilation');
    redactor.register('current-credential-7382');

    expect(redactor.redactText('retired-credential-4921 current-credential-7382')).toBe(
      `${REDACTED} ${REDACTED}`,
    );
    expect(redactor.redactText(JSON.stringify(redactor))).toBe('{}');
  });

  it('rejects empty or malformed secret registration with fixed error details', () => {
    const redactor = new SecretRedactor();
    expect(() => redactor.register('')).toThrow(SecretRegistrationError);
    expect(() => redactor.register('\uD800')).toThrow(
      'The value cannot be registered for secret redaction.',
    );
  });

  it('preserves nested record and array shape while replacing credential fields', () => {
    const redactor = new SecretRedactor();
    const source = {
      status: 'ready',
      count: 3,
      active: true,
      missing: null,
      absent: undefined,
      headers: { Authorization: 'unknown bearer', 'X-API-Key': 'unknown API key' },
      nested: [{ password: 'unknown password', client_secret: 'unknown client secret' }],
      credentials: { values: ['first value', 'second value'], flag: 123 },
      secretRef: 'secret://sec_01JK01ABCDEFGHJKMNPQRSTVWXYZ',
      idempotencyKey: 'intent-3912',
    };

    expect(redactor.redact(source)).toEqual({
      ...source,
      headers: { Authorization: REDACTED, 'X-API-Key': REDACTED },
      nested: [{ password: REDACTED, client_secret: REDACTED }],
      credentials: { values: [REDACTED, REDACTED], flag: REDACTED },
    });
    expect(source.nested[0]?.password).toBe('unknown password');
  });

  it('scrubs registered values from model-bound output, error messages, stacks, causes, and keys', () => {
    const redactor = new SecretRedactor();
    const canary = 'vault-canary-model-context-4381';
    redactor.register(canary);
    const error = new Error(`request failed with ${canary}`, {
      cause: new Error(`nested ${canary}`),
    });
    const modelContext = redactor.redact({
      toolOutput: [{ content: `untrusted response: ${canary}`, [canary]: canary }],
      error,
    });

    const serialized = JSON.stringify(modelContext);
    expect(serialized).not.toContain(canary);
    expect(serialized).toContain(REDACTED);
    expect(modelContext).toMatchObject({
      error: {
        name: 'Error',
        message: `request failed with ${REDACTED}`,
        cause: { message: `nested ${REDACTED}` },
      },
    });
    expect(error.message).toContain(canary);
  });

  it('handles cycles and preserves repeated shared values without mistaking them for cycles', () => {
    const redactor = new SecretRedactor();
    const shared = { safe: 'value' };
    const source: Record<string, unknown> = { left: shared, right: shared };
    source['self'] = source;

    expect(redactor.redact(source)).toEqual({ left: shared, right: shared, self: '[Circular]' });
  });

  it('never invokes accessors or custom serialization functions', () => {
    const redactor = new SecretRedactor();
    let accessed = false;
    const source = {
      get result() {
        accessed = true;
        return 'unregistered credential';
      },
      toJSON() {
        accessed = true;
        return 'unregistered credential';
      },
    };

    expect(JSON.stringify(redactor.redact(source))).toBe(
      JSON.stringify({ result: REDACTED, toJSON: REDACTED }),
    );
    expect(accessed).toBe(false);
  });

  it('fails closed on uninspectable objects and bounded recursion', () => {
    const redactor = new SecretRedactor();
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('sensitive trap detail');
        },
      },
    );
    let deep: unknown = { value: 'ordinary text' };
    for (let index = 0; index < 70; index += 1) {
      deep = { next: deep };
    }

    expect(redactor.redact(proxy)).toBe(REDACTED);
    expect(JSON.stringify(redactor.redact(deep))).toContain(REDACTED);
    expect(JSON.stringify(redactor.redact(deep))).not.toContain('ordinary text');
  });

  it('neutralizes prototype keys without mutating Object.prototype', () => {
    const redactor = new SecretRedactor();
    const source: unknown = JSON.parse('{"__proto__":{"password":"hidden"},"safe":"value"}');
    const result = redactor.redact(source);

    expect(JSON.stringify(result)).toBe('{"__proto__":{"password":"[REDACTED]"},"safe":"value"}');
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty('password');
  });

  it('serializes safe dates, URLs, maps, sets, and scalar values while dropping binary material', () => {
    const redactor = new SecretRedactor();
    redactor.register('canary-encoded-4821');
    const date = new Date('2026-11-03T00:00:00.000Z');
    Object.defineProperty(date, 'toJSON', { value: () => 'unregistered secret' });

    expect(redactor.redact(date)).toBe('2026-11-03T00:00:00.000Z');
    expect(redactor.redact(new Date('invalid'))).toBeNull();
    expect(redactor.redact(new URL('https://name:unknown-password@example.com/status'))).toBe(
      `https://${REDACTED}@example.com/status`,
    );
    expect(
      redactor.redact(
        new Map([
          ['password', 'unknown-password'],
          ['label', 'canary-encoded-4821'],
        ]),
      ),
    ).toEqual([
      ['password', REDACTED],
      ['label', REDACTED],
    ]);
    expect(redactor.redact(new Set(['canary-encoded-4821']))).toEqual([REDACTED]);
    expect(redactor.redact(9n)).toBe('9');
    expect(redactor.redact(Symbol('canary-encoded-4821'))).toBe(`Symbol(${REDACTED})`);
    expect(redactor.redact(Buffer.from('canary-encoded-4821'))).toBe(REDACTED);
    expect(redactor.redact(new ArrayBuffer(16))).toBe(REDACTED);
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = 'ordinary';
    expect(redactor.redact(sparse)).toEqual(sparse);
  });

  it.each([
    'Bearer unknowncredential3819',
    'Basic dXNlcjpwYXNzd29yZA==',
    'postgresql://user:unregistered@example.com/database',
    'api_key=unknowncredential3819',
    'password="unknown credential with spaces"',
    "client_secret='unknown credential with spaces'",
    'sk-123456789012345678901234',
    'ghp_123456789012345678901234',
    'AKIA12345678ABCDEFGH',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.abcdef123456',
    '-----BEGIN PRIVATE KEY-----\ncanary material\n-----END PRIVATE KEY-----',
  ])('detects common unregistered credential representations: %s', (value) => {
    const redactor = new SecretRedactor();
    expect(redactor.redactText(value)).not.toBe(value);
    expect(redactor.redactText(value)).toContain(REDACTED);
  });

  it('scrubs complete cookie headers and leaves scrubbed strings stable on repeated passes', () => {
    const redactor = new SecretRedactor();
    redactor.register('registered-credential');
    const input = 'Cookie: first=unknown-one; second=unknown-two\npassword=registered-credential';
    const scrubbed = `Cookie: ${REDACTED}\npassword=${REDACTED}`;

    expect(redactor.redactText(input)).toBe(scrubbed);
    expect(redactor.redactText(scrubbed)).toBe(scrubbed);
    const json = '{"password":"registered-credential","access_token":"unknown"}';
    expect(JSON.parse(redactor.redactText(json))).toEqual({
      password: REDACTED,
      access_token: REDACTED,
    });
  });

  it('scrubs prefixed credential names and userinfo in punctuated URI schemes', () => {
    const redactor = new SecretRedactor();

    expect(
      redactor.redactText(
        'servicePassword=hidden "client-secret":"hidden"; X-Authorization=hidden',
      ),
    ).toBe(
      `servicePassword=${REDACTED} "client-secret":"${REDACTED}"; X-Authorization=${REDACTED}`,
    );
    expect(redactor.redactText('postgresql+driver.v1://name:hidden@example.com/database')).toBe(
      `postgresql+driver.v1://${REDACTED}@example.com/database`,
    );
    expect(redactor.redactText('\n\tCookie : first=hidden; second=hidden\nstatus: ready')).toBe(
      `\n\tCookie : ${REDACTED}\nstatus: ready`,
    );
    expect(redactor.redactText('secret://sec_01JK01ABCDEFGHJKMNPQRSTVWXYZ')).toBe(
      'secret://sec_01JK01ABCDEFGHJKMNPQRSTVWXYZ',
    );
  });

  it.each(['x', 'x-', 'x.', '\n', 'eyJ-'])(
    'handles long untrusted %j text without repeated scanning and still scrubs its final credential',
    (segment) => {
      const redactor = new SecretRedactor();
      const prefix = segment.repeat(65_536 / segment.length);
      const start = performance.now();
      const result = redactor.redactText(`${prefix}\napi_key=unregistered-canary`);
      const elapsed = performance.now() - start;

      expect(result).toBe(`${prefix}\napi_key=${REDACTED}`);
      // The previous unanchored patterns take seconds at this size; leave ample CI headroom.
      expect(elapsed).toBeLessThan(500);
    },
  );

  it('fails closed on incomplete private keys without rescanning repeated opening markers', () => {
    const redactor = new SecretRedactor();
    const input = '-----BEGIN PRIVATE KEY-----\n'.repeat(20_000) + 'private material';
    const start = performance.now();
    const result = redactor.redactText(input);
    const elapsed = performance.now() - start;

    expect(result).toBe(REDACTED);
    expect(elapsed).toBeLessThan(500);
    expect(
      redactor.redactText(
        'before -----BEGIN RSA PRIVATE KEY-----\nprivate material\n-----END RSA PRIVATE KEY----- after',
      ),
    ).toBe(`before ${REDACTED} after`);
  });
});
