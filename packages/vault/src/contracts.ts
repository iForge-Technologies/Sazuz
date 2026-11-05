import { z } from 'zod';

const canonicalBase64 = (bytes: number) =>
  z
    .string()
    .length(Math.ceil((bytes * 8) / 6))
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine(
      (value) =>
        Buffer.from(value, 'base64url').length === bytes &&
        Buffer.from(value, 'base64url').toString('base64url') === value,
    );

export const vaultModeSchema = z.enum(['auto', 'strict']);
export type VaultMode = z.infer<typeof vaultModeSchema>;

export const secretIdSchema = z.string().regex(/^sec_[0-9A-HJKMNP-TV-Z]{26}$/);
export const secretReferenceSchema = z.string().regex(/^secret:\/\/sec_[0-9A-HJKMNP-TV-Z]{26}$/);
export type SecretReference = `secret://${string}`;

export const encryptedEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  nonce: canonicalBase64(24),
  ciphertext: z
    .string()
    .min(22)
    .max(87_404)
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((value) => Buffer.from(value, 'base64url').toString('base64url') === value),
});
export type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>;

const wrappedMasterSchema = encryptedEnvelopeSchema.refine(
  (value) => Buffer.from(value.ciphertext, 'base64url').length === 48,
);

export const vaultKdfSchema = z.strictObject({
  algorithm: z.literal('argon2id13'),
  memoryKiB: z.literal(65_536),
  iterations: z.literal(3),
  parallelism: z.literal(1),
  salt: canonicalBase64(16),
});
export type VaultKdf = z.infer<typeof vaultKdfSchema>;

export const vaultWorkspaceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const scopeIdSchema = vaultWorkspaceIdSchema;
const timestampSchema = z.iso.datetime();

export const vaultMetadataSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    revision: z.number().int().positive(),
    workspaceId: scopeIdSchema,
    mode: vaultModeSchema,
    kdf: vaultKdfSchema,
    passphraseEnvelope: wrappedMasterSchema,
    recoveryEnvelope: wrappedMasterSchema,
    machineEnvelope: wrappedMasterSchema.nullable(),
    recoveryConfirmationHash: canonicalBase64(32),
    recoveryAcknowledgedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .refine((value) => (value.mode === 'strict') === (value.machineEnvelope === null));
export type VaultMetadata = z.infer<typeof vaultMetadataSchema>;

export const storedSecretSchema = z.strictObject({
  id: secretIdSchema,
  workspaceId: scopeIdSchema,
  purpose: z.enum(['user', 'authentication', 'browser-profiles', 'web-push']),
  name: z.string().trim().min(1).max(128),
  createdBy: scopeIdSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  revision: z.number().int().positive(),
  envelope: encryptedEnvelopeSchema,
  maskedValue: z.string().min(1).max(32),
});
export type StoredSecret = z.infer<typeof storedSecretSchema>;
export type SecretPurpose = StoredSecret['purpose'];

/** Storage implementations must commit each method atomically and return detached values. */
export interface VaultRepository {
  readMetadata(): Promise<VaultMetadata | null>;
  /** null creates once; a revision replaces only that exact committed revision. */
  writeMetadata(next: VaultMetadata, expectedRevision: number | null): Promise<boolean>;
  insertSecret(row: StoredSecret): Promise<boolean>;
  readSecret(id: string): Promise<StoredSecret | null>;
  listSecrets(workspaceId: string): Promise<StoredSecret[]>;
  updateSecret(row: StoredSecret, expectedRevision: number): Promise<boolean>;
  deleteSecret(id: string, workspaceId: string): Promise<boolean>;
}

export interface SecretMetadata {
  id: string;
  reference: SecretReference;
  name: string;
  maskedValue: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface VaultStatus {
  initialized: boolean;
  locked: boolean;
  mode: VaultMode | null;
  recoveryConfirmed: boolean;
}

/** Privileged, one-time provisioning material. Never persist or log this result. */
export interface RecoveryKit {
  key: string;
  text: string;
  confirmationHint: string;
}

export const createSecretSchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  value: z
    .string()
    .min(1)
    .max(65_536)
    .refine((value) => {
      try {
        encodeURIComponent(value);
        return Buffer.byteLength(value, 'utf8') <= 65_536;
      } catch {
        return false;
      }
    }),
  createdBy: scopeIdSchema,
});
export type CreateSecretInput = z.infer<typeof createSecretSchema>;
export const updateSecretSchema = createSecretSchema.omit({ createdBy: true });
export type UpdateSecretInput = z.infer<typeof updateSecretSchema>;

export const vaultErrorMessages = {
  VAULT_INVALID_INPUT: 'The vault request is invalid.',
  VAULT_NOT_INITIALIZED: 'The vault has not been initialized.',
  VAULT_ALREADY_INITIALIZED: 'The vault has already been initialized.',
  VAULT_LOCKED: 'The vault is locked.',
  VAULT_UNLOCK_FAILED: 'The vault could not be unlocked with that credential.',
  VAULT_RECOVERY_UNCONFIRMED: 'The recovery confirmation does not match.',
  VAULT_MACHINE_KEY_REQUIRED: 'A private machine key is required for automatic unlock.',
  VAULT_DATA_INVALID: 'The stored vault data is invalid.',
  VAULT_CONFLICT: 'The vault changed during this operation. Try again.',
  VAULT_STORAGE_FAILED: 'The vault storage operation could not be completed.',
  VAULT_SECRET_NOT_FOUND: 'The requested secret is unavailable.',
  VAULT_DECRYPTION_FAILED: 'The encrypted value could not be verified.',
  VAULT_CRYPTO_FAILED: 'The vault cryptographic operation could not be completed.',
} as const;
export type VaultErrorCode = keyof typeof vaultErrorMessages;

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode) {
    super(vaultErrorMessages[code]);
    this.name = 'VaultError';
    this.code = code;
  }
}
