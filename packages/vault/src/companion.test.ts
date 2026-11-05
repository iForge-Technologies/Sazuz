import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CompanionVault } from './companion.js';

describe('companion envelope vault', () => {
  it('uses Argon2id and authenticated envelopes with automatic or passphrase unlock and bound record names', async () => {
    const key = randomBytes(32),
      passphrase = 'companion-crypto-passphrase';
    const initial = await CompanionVault.initialize(passphrase, key);
    const envelope = initial.encrypt('credential', { token: 'companion-token-marker' });
    expect(initial.metadata.kdf.algorithm).toBe('argon2id13');
    expect(JSON.stringify({ envelope, metadata: initial.metadata })).not.toContain(
      'companion-token-marker',
    );
    for (const credential of [undefined, passphrase]) {
      const opened = await CompanionVault.unlock(initial.metadata, key, credential);
      const value = await opened.consume(
        'credential',
        envelope,
        z.object({ token: z.string() }),
        (item) => Promise.resolve(item.token),
      );
      expect(value).toBe('companion-token-marker');
      await expect(
        opened.consume('another-record', envelope, z.json(), (item) => Promise.resolve(item)),
      ).rejects.toThrow();
      opened.close();
    }
    await expect(CompanionVault.unlock(initial.metadata, randomBytes(32))).rejects.toThrow();
    await expect(
      CompanionVault.unlock(initial.metadata, key, 'incorrect-passphrase'),
    ).rejects.toThrow();
    expect(() => initial.encrypt('large', 'x'.repeat(33000))).toThrow();
    initial.close();
    expect(() => initial.encrypt('closed', 'refused')).toThrow();
    await expect(
      initial.consume('credential', envelope, z.json(), (value) => Promise.resolve(value)),
    ).rejects.toThrow();
  });
});
