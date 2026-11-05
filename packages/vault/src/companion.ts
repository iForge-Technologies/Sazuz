import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { encryptedEnvelopeSchema, vaultKdfSchema, VaultError } from './contracts.js';
import {
  clearBytes,
  derivePassphraseKey,
  newKdf,
  randomKey,
  readyCrypto,
  seal,
  unseal,
} from './crypto.js';
import { secretRedactor } from './redaction.js';

export const companionMetadataSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  kdf: vaultKdfSchema,
  passphraseEnvelope: encryptedEnvelopeSchema,
  machineEnvelope: encryptedEnvelopeSchema,
});
export type CompanionMetadata = z.infer<typeof companionMetadataSchema>;

/** A disposable companion vault uses the same Argon2id/envelope primitives as the server vault. */
export class CompanionVault {
  private closed = false;
  private constructor(
    private readonly master: Uint8Array,
    readonly metadata: CompanionMetadata,
  ) {}
  static async initialize(passphrase: string, machine: Uint8Array) {
    z.string().min(12).max(256).parse(passphrase);
    if (machine.length !== 32) throw new VaultError('VAULT_INVALID_INPUT');
    await readyCrypto();
    secretRedactor.register(passphrase);
    const master = randomKey(),
      kdf = newKdf(),
      id = randomUUID(),
      wrapping = derivePassphraseKey(passphrase, kdf);
    try {
      const metadata = companionMetadataSchema.parse({
        version: 1,
        id,
        kdf,
        passphraseEnvelope: seal(master, wrapping, ['sazuz-bridge-key', id, kdf]),
        machineEnvelope: seal(master, machine, ['sazuz-bridge-key', id, 'machine']),
      });
      return new CompanionVault(new Uint8Array(master), metadata);
    } finally {
      clearBytes(master, wrapping);
    }
  }
  static async unlock(input: unknown, machine: Uint8Array, passphrase?: string) {
    const metadata = companionMetadataSchema.parse(input);
    await readyCrypto();
    if (machine.length !== 32) throw new VaultError('VAULT_INVALID_INPUT');
    const key =
      passphrase === undefined
        ? new Uint8Array(machine)
        : derivePassphraseKey(z.string().min(12).max(256).parse(passphrase), metadata.kdf);
    try {
      if (passphrase !== undefined) secretRedactor.register(passphrase);
      return new CompanionVault(
        unseal(
          passphrase === undefined ? metadata.machineEnvelope : metadata.passphraseEnvelope,
          key,
          ['sazuz-bridge-key', metadata.id, passphrase === undefined ? 'machine' : metadata.kdf],
        ),
        metadata,
      );
    } finally {
      clearBytes(key);
    }
  }
  encrypt(name: string, value: unknown) {
    if (this.closed) throw new VaultError('VAULT_LOCKED');
    const bytes = Buffer.from(JSON.stringify(value));
    try {
      if (bytes.length > 32_768) throw new VaultError('VAULT_INVALID_INPUT');
      return seal(bytes, this.master, ['sazuz-bridge-value', this.metadata.id, name]);
    } finally {
      clearBytes(bytes);
    }
  }
  async consume<T, R>(
    name: string,
    value: unknown,
    schema: z.ZodType<T>,
    consume: (value: T) => Promise<R>,
  ): Promise<R> {
    if (this.closed) throw new VaultError('VAULT_LOCKED');
    const bytes = unseal(encryptedEnvelopeSchema.parse(value), this.master, [
      'sazuz-bridge-value',
      this.metadata.id,
      name,
    ]);
    try {
      return await consume(
        schema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown),
      );
    } finally {
      clearBytes(bytes);
    }
  }
  close() {
    this.closed = true;
    clearBytes(this.master);
  }
}
