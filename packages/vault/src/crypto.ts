import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';

import {
  VaultError,
  type EncryptedEnvelope,
  type SecretPurpose,
  type VaultKdf,
} from './contracts.js';

export async function readyCrypto(): Promise<void> {
  try {
    await sodium.ready;
  } catch {
    throw new VaultError('VAULT_CRYPTO_FAILED');
  }
}

export function randomKey(): Uint8Array {
  return sodium.randombytes_buf(32);
}

export function clearBytes(...values: (Uint8Array | undefined)[]): void {
  for (const value of values) {
    if (value !== undefined) sodium.memzero(value);
  }
}

export function encodeBytes(value: Uint8Array): string {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64url');
}

export function decodeBytes(value: string): Uint8Array {
  return Buffer.from(value, 'base64url');
}

export function newKdf(): VaultKdf {
  return {
    algorithm: 'argon2id13',
    memoryKiB: 65_536,
    iterations: 3,
    parallelism: 1,
    salt: encodeBytes(sodium.randombytes_buf(16)),
  };
}

export function derivePassphraseKey(passphrase: string, kdf: VaultKdf): Uint8Array {
  const bytes = Buffer.from(passphrase, 'utf8');
  const salt = decodeBytes(kdf.salt);
  try {
    // libsodium's Argon2id implementation fixes parallelism at one lane.
    return sodium.crypto_pwhash(
      32,
      bytes,
      salt,
      kdf.iterations,
      kdf.memoryKiB * 1024,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
  } catch {
    throw new VaultError('VAULT_CRYPTO_FAILED');
  } finally {
    clearBytes(bytes, salt);
  }
}

export function derivePurposeKey(
  rootKey: Uint8Array,
  workspaceId: string,
  purpose:
    | 'secrets'
    | 'authentication'
    | 'browser-profiles'
    | 'web-push'
    | 'recovery-confirmation'
    | 'backups'
    | 'backup-rollback',
): Uint8Array {
  try {
    return new Uint8Array(hkdfSync('sha256', rootKey, workspaceId, `sazuz:v1:${purpose}`, 32));
  } catch {
    throw new VaultError('VAULT_CRYPTO_FAILED');
  }
}

export function seal(
  plaintext: Uint8Array,
  key: Uint8Array,
  context: readonly unknown[],
): EncryptedEnvelope {
  const nonce = sodium.randombytes_buf(24);
  let encrypted: Uint8Array | undefined;
  try {
    encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      JSON.stringify(context),
      null,
      nonce,
      key,
    );
    return { version: 1, nonce: encodeBytes(nonce), ciphertext: encodeBytes(encrypted) };
  } catch {
    throw new VaultError('VAULT_CRYPTO_FAILED');
  } finally {
    clearBytes(nonce, encrypted);
  }
}

export function unseal(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  context: readonly unknown[],
): Uint8Array {
  const nonce = decodeBytes(envelope.nonce);
  const ciphertext = decodeBytes(envelope.ciphertext);
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      JSON.stringify(context),
      nonce,
      key,
    );
  } catch {
    throw new VaultError('VAULT_DECRYPTION_FAILED');
  } finally {
    clearBytes(nonce, ciphertext);
  }
}

export function masterContext(
  workspaceId: string,
  kind: 'passphrase' | 'recovery' | 'machine',
  kdf?: VaultKdf,
): readonly unknown[] {
  return ['sazuz', 1, 'master-key', workspaceId, kind, kdf ?? null];
}

export function secretContext(
  workspaceId: string,
  secretId: string,
  purpose: SecretPurpose,
): readonly unknown[] {
  // A tuple has unambiguous boundaries; moving ciphertext between rows or scopes fails authentication.
  return ['sazuz', 1, 'secret', workspaceId, secretId, purpose];
}

export function recoveryConfirmation(
  masterKey: Uint8Array,
  workspaceId: string,
  envelope: EncryptedEnvelope,
  characters: string,
): string {
  const key = derivePurposeKey(masterKey, workspaceId, 'recovery-confirmation');
  let digest: Uint8Array | undefined;
  try {
    digest = createHmac('sha256', key)
      .update(JSON.stringify(['sazuz', 1, 'recovery-confirmation', envelope, characters]))
      .digest();
    return encodeBytes(digest);
  } finally {
    clearBytes(key, digest);
  }
}

export function equalEncoded(left: string, right: string): boolean {
  const leftBytes = decodeBytes(left);
  const rightBytes = decodeBytes(right);
  try {
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } finally {
    clearBytes(leftBytes, rightBytes);
  }
}
