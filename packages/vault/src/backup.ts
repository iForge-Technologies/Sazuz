import { createHash } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';
import { z } from 'zod';
import {
  encryptedEnvelopeSchema,
  vaultKdfSchema,
  vaultWorkspaceIdSchema,
  VaultError,
} from './contracts.js';
import {
  clearBytes,
  decodeBytes,
  derivePassphraseKey,
  derivePurposeKey,
  encodeBytes,
  masterContext,
  readyCrypto,
  seal,
  unseal,
} from './crypto.js';
import { secretRedactor } from './redaction.js';

const magic = Buffer.from('SAZUZB1\n');
const keyWrap = encryptedEnvelopeSchema.refine(
  (value) => Buffer.from(value.ciphertext, 'base64url').length === 48,
);
export const backupHeaderSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(/^bak_[0-9A-HJKMNP-TV-Z]{26}$/),
  createdAt: z.iso.datetime(),
  workspaceId: vaultWorkspaceIdSchema,
  kdf: vaultKdfSchema,
  passphraseEnvelope: keyWrap,
  recoveryEnvelope: keyWrap,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  rollback: z
    .strictObject({
      operationId: z.string().regex(/^op_[0-9A-HJKMNP-TV-Z]{26}$/),
      envelope: keyWrap,
    })
    .nullable(),
});
export type BackupHeader = z.infer<typeof backupHeaderSchema>;
export type BackupWrapping = Pick<
  BackupHeader,
  'workspaceId' | 'kdf' | 'passphraseEnvelope' | 'recoveryEnvelope'
>;
const context = (header: BackupHeader) =>
  Buffer.from(JSON.stringify(['sazuz', 1, 'backup', header]));

export async function sealBackup(
  payload: Uint8Array,
  key: Uint8Array,
  wrapping: BackupWrapping,
  input: {
    id: string;
    createdAt: string;
    rollback?: { operationId: string; authenticationKey: Uint8Array } | undefined;
  },
): Promise<Buffer> {
  await readyCrypto();
  let rollback: BackupHeader['rollback'] = null;
  if (input.rollback) {
    const purpose = derivePurposeKey(
      input.rollback.authenticationKey,
      wrapping.workspaceId,
      'backup-rollback',
    );
    try {
      rollback = {
        operationId: input.rollback.operationId,
        envelope: seal(key, purpose, [
          'sazuz',
          1,
          'backup-rollback',
          input.rollback.operationId,
          input.id,
        ]),
      };
    } finally {
      clearBytes(purpose);
    }
  }
  const header = backupHeaderSchema.parse({
    ...wrapping,
    version: 1,
    id: input.id,
    createdAt: input.createdAt,
    nonce: encodeBytes(sodium.randombytes_buf(24)),
    rollback,
  });
  const json = Buffer.from(JSON.stringify(header));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(json.length);
  const encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    payload,
    context(header),
    null,
    decodeBytes(header.nonce),
    key,
  );
  try {
    return Buffer.concat([magic, size, json, encrypted]);
  } finally {
    clearBytes(encrypted);
  }
}
export function inspectBackup(bytes: Uint8Array): { header: BackupHeader; ciphertext: Uint8Array } {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 28 || !buffer.subarray(0, 8).equals(magic))
    throw new VaultError('VAULT_DATA_INVALID');
  const size = buffer.readUInt32BE(8);
  if (size > 8192 || size < 64 || size + 28 > buffer.length)
    throw new VaultError('VAULT_DATA_INVALID');
  try {
    return {
      header: backupHeaderSchema.parse(JSON.parse(buffer.subarray(12, 12 + size).toString('utf8'))),
      ciphertext: buffer.subarray(12 + size),
    };
  } catch {
    throw new VaultError('VAULT_DATA_INVALID');
  }
}
export async function openBackup<T>(
  bytes: Uint8Array,
  credential: string,
  consume: (payload: Uint8Array, header: BackupHeader) => Promise<T>,
): Promise<T> {
  await readyCrypto();
  secretRedactor.register(credential);
  const { header, ciphertext } = inspectBackup(bytes);
  let wrapping: Uint8Array | undefined,
    master: Uint8Array | undefined,
    key: Uint8Array | undefined,
    payload: Uint8Array | undefined;
  try {
    if (/^sazuz-recovery-v1:[A-Za-z0-9_-]{43}$/.test(credential)) {
      wrapping = decodeBytes(credential.slice('sazuz-recovery-v1:'.length));
      master = unseal(
        header.recoveryEnvelope,
        wrapping,
        masterContext(header.workspaceId, 'recovery'),
      );
    } else {
      wrapping = derivePassphraseKey(z.string().min(12).max(256).parse(credential), header.kdf);
      master = unseal(
        header.passphraseEnvelope,
        wrapping,
        masterContext(header.workspaceId, 'passphrase', header.kdf),
      );
    }
    key = derivePurposeKey(master, header.workspaceId, 'backups');
    payload = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      context(header),
      decodeBytes(header.nonce),
      key,
    );
  } catch {
    clearBytes(wrapping, master, key, payload);
    throw new VaultError('VAULT_DATA_INVALID');
  }
  try {
    return await consume(payload, header);
  } finally {
    clearBytes(wrapping, master, key, payload);
  }
}
export async function openRollbackBackup<T>(
  bytes: Uint8Array,
  operationId: string,
  authenticationKey: Uint8Array,
  consume: (payload: Uint8Array, header: BackupHeader) => Promise<T>,
): Promise<T> {
  await readyCrypto();
  const { header, ciphertext } = inspectBackup(bytes);
  if (header.rollback?.operationId !== operationId) throw new VaultError('VAULT_INVALID_INPUT');
  const purpose = derivePurposeKey(authenticationKey, header.workspaceId, 'backup-rollback');
  let key: Uint8Array | undefined, payload: Uint8Array | undefined;
  try {
    key = unseal(header.rollback.envelope, purpose, [
      'sazuz',
      1,
      'backup-rollback',
      operationId,
      header.id,
    ]);
    payload = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      context(header),
      decodeBytes(header.nonce),
      key,
    );
  } catch {
    clearBytes(purpose, key, payload);
    throw new VaultError('VAULT_DATA_INVALID');
  }
  try {
    return await consume(payload, header);
  } finally {
    clearBytes(purpose, key, payload);
  }
}
export const backupChecksum = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
