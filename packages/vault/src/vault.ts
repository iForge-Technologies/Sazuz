import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import {
  createSecretSchema,
  secretIdSchema,
  secretReferenceSchema,
  storedSecretSchema,
  updateSecretSchema,
  vaultMetadataSchema,
  vaultWorkspaceIdSchema,
  VaultError,
  type RecoveryKit,
  type SecretMetadata,
  type SecretPurpose,
  type SecretReference,
  type StoredSecret,
  type VaultMetadata,
  type VaultMode,
  type VaultRepository,
} from './contracts.js';
import {
  clearBytes,
  decodeBytes,
  derivePassphraseKey,
  derivePurposeKey,
  encodeBytes,
  equalEncoded,
  masterContext,
  newKdf,
  randomKey,
  readyCrypto,
  recoveryConfirmation,
  seal,
  secretContext,
  unseal,
} from './crypto.js';
import { secretRedactor } from './redaction.js';
import { parseBoundary, requireCommit, storageCall, VaultMutex } from './storage.js';
import { sealBackup } from './backup.js';

const passphraseSchema = z.string().min(12).max(256);
const recoveryKeySchema = z.string().regex(/^sazuz-recovery-v1:[A-Za-z0-9_-]{43}$/);
const metadata = (row: StoredSecret): SecretMetadata => ({
  id: row.id,
  reference: `secret://${row.id}`,
  name: row.name,
  maskedValue: row.maskedValue,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  revision: row.revision,
});

/** Only the execution callback receives a resolved value. No general plaintext read API. */
export class Vault {
  #master: Uint8Array | undefined;
  #mutex = new VaultMutex();
  constructor(
    readonly repository: VaultRepository,
    readonly workspaceId: string,
    readonly machineKey: Uint8Array,
    readonly authenticationKey: Uint8Array,
  ) {
    parseBoundary(vaultWorkspaceIdSchema, workspaceId);
    if (machineKey.length !== 32 || authenticationKey.length !== 32)
      throw new VaultError('VAULT_INVALID_INPUT');
  }
  async #read(): Promise<VaultMetadata | null> {
    const value = await storageCall(() => this.repository.readMetadata());
    if (value === null) return null;
    const result = parseBoundary(vaultMetadataSchema, value, 'VAULT_DATA_INVALID');
    if (result.workspaceId !== this.workspaceId) throw new VaultError('VAULT_DATA_INVALID');
    return result;
  }
  async status() {
    const row = await this.#read();
    return {
      initialized: row !== null,
      locked: this.#master === undefined,
      mode: row?.mode ?? null,
      recoveryConfirmed: row?.recoveryAcknowledgedAt !== null && row !== null,
    };
  }
  async backup(
    capture: () => Promise<Uint8Array>,
    input: {
      id: string;
      createdAt: string;
      rollbackOperationId?: string | undefined;
      rollbackKey?: Uint8Array | undefined;
    },
  ): Promise<Buffer> {
    return this.#mutex.run(async () => {
      const row = await this.#read();
      if (!row || !this.#master) throw new VaultError('VAULT_LOCKED');
      if (input.rollbackKey && (!input.rollbackOperationId || input.rollbackKey.length !== 32))
        throw new VaultError('VAULT_INVALID_INPUT');
      const key = derivePurposeKey(this.#master, this.workspaceId, 'backups');
      let payload: Uint8Array | undefined;
      try {
        payload = await capture();
        return await sealBackup(
          payload,
          key,
          {
            workspaceId: this.workspaceId,
            kdf: row.kdf,
            passphraseEnvelope: row.passphraseEnvelope,
            recoveryEnvelope: row.recoveryEnvelope,
          },
          {
            id: input.id,
            createdAt: input.createdAt,
            ...(input.rollbackOperationId
              ? {
                  rollback: {
                    operationId: input.rollbackOperationId,
                    authenticationKey: input.rollbackKey ?? this.authenticationKey,
                  },
                }
              : {}),
          },
        );
      } finally {
        clearBytes(key, payload);
      }
    });
  }
  async initialize(passphrase: string, mode: VaultMode): Promise<RecoveryKit> {
    return this.#mutex.run(async () => {
      parseBoundary(passphraseSchema, passphrase);
      parseBoundary(z.enum(['auto', 'strict']), mode);
      secretRedactor.register(passphrase);
      await readyCrypto();
      if (await this.#read()) throw new VaultError('VAULT_ALREADY_INITIALIZED');
      const master = randomKey();
      const kdf = newKdf();
      const key = derivePassphraseKey(passphrase, kdf);
      const recovery = randomKey();
      const encoded = `sazuz-recovery-v1:${encodeBytes(recovery)}`;
      secretRedactor.register(encoded);
      const now = new Date().toISOString();
      const recoveryEnvelope = seal(master, recovery, masterContext(this.workspaceId, 'recovery'));
      try {
        const row: VaultMetadata = {
          formatVersion: 1,
          revision: 1,
          workspaceId: this.workspaceId,
          mode,
          kdf,
          passphraseEnvelope: seal(master, key, masterContext(this.workspaceId, 'passphrase', kdf)),
          recoveryEnvelope,
          machineEnvelope:
            mode === 'auto'
              ? seal(master, this.machineKey, masterContext(this.workspaceId, 'machine'))
              : null,
          recoveryConfirmationHash: recoveryConfirmation(
            master,
            this.workspaceId,
            recoveryEnvelope,
            encoded.slice(-4),
          ),
          recoveryAcknowledgedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        requireCommit(await storageCall(() => this.repository.writeMetadata(row, null)));
        this.#master = new Uint8Array(master);
        return {
          key: encoded,
          text: `Sazuz Recovery Kit v1\nWorkspace: ${this.workspaceId}\nRecovery key: ${encoded}\nKeep this file offline. Anyone with this key and your database can unlock your vault.\n`,
          confirmationHint: 'Type the last four characters of the recovery key.',
        };
      } finally {
        clearBytes(master, key, recovery);
      }
    });
  }
  async unlock(credential?: string): Promise<void> {
    return this.#mutex.run(async () => {
      await readyCrypto();
      const row = await this.#read();
      if (!row) throw new VaultError('VAULT_NOT_INITIALIZED');
      let key: Uint8Array | undefined;
      let master: Uint8Array | undefined;
      try {
        if (credential === undefined) {
          if (!row.machineEnvelope) throw new VaultError('VAULT_LOCKED');
          master = unseal(
            row.machineEnvelope,
            this.machineKey,
            masterContext(this.workspaceId, 'machine'),
          );
        } else {
          secretRedactor.register(credential);
          if (recoveryKeySchema.safeParse(credential).success) {
            key = decodeBytes(credential.slice('sazuz-recovery-v1:'.length));
            master = unseal(row.recoveryEnvelope, key, masterContext(this.workspaceId, 'recovery'));
          } else {
            parseBoundary(passphraseSchema, credential);
            key = derivePassphraseKey(credential, row.kdf);
            master = unseal(
              row.passphraseEnvelope,
              key,
              masterContext(this.workspaceId, 'passphrase', row.kdf),
            );
          }
        }
        clearBytes(this.#master);
        this.#master = new Uint8Array(master);
      } catch {
        throw new VaultError(credential === undefined ? 'VAULT_LOCKED' : 'VAULT_UNLOCK_FAILED');
      } finally {
        clearBytes(key, master);
      }
    });
  }
  async lock(): Promise<void> {
    await this.#mutex.run(() => {
      clearBytes(this.#master);
      this.#master = undefined;
    });
  }
  async confirmRecovery(characters: string): Promise<void> {
    await this.#mutex.run(async () => {
      const row = await this.#read();
      if (!row) throw new VaultError('VAULT_NOT_INITIALIZED');
      if (!this.#master) throw new VaultError('VAULT_LOCKED');
      if (
        !equalEncoded(
          row.recoveryConfirmationHash,
          recoveryConfirmation(this.#master, this.workspaceId, row.recoveryEnvelope, characters),
        )
      )
        throw new VaultError('VAULT_RECOVERY_UNCONFIRMED');
      requireCommit(
        await storageCall(() =>
          this.repository.writeMetadata(
            {
              ...row,
              revision: row.revision + 1,
              recoveryAcknowledgedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            row.revision,
          ),
        ),
      );
    });
  }
  async changeMode(passphrase: string, mode: VaultMode): Promise<void> {
    await this.unlock(passphrase);
    await this.#mutex.run(async () => {
      const row = await this.#read();
      if (!row || !this.#master) throw new VaultError('VAULT_LOCKED');
      parseBoundary(z.enum(['auto', 'strict']), mode);
      requireCommit(
        await storageCall(() =>
          this.repository.writeMetadata(
            {
              ...row,
              mode,
              revision: row.revision + 1,
              machineEnvelope:
                mode === 'auto'
                  ? seal(this.#master!, this.machineKey, masterContext(this.workspaceId, 'machine'))
                  : null,
              updatedAt: new Date().toISOString(),
            },
            row.revision,
          ),
        ),
      );
    });
  }
  async regenerateRecovery(credential: string): Promise<RecoveryKit> {
    await this.unlock(credential);
    return this.#mutex.run(async () => {
      const row = await this.#read();
      if (!row || !this.#master) throw new VaultError('VAULT_LOCKED');
      const key = randomKey();
      const encoded = `sazuz-recovery-v1:${encodeBytes(key)}`;
      secretRedactor.register(encoded);
      try {
        const envelope = seal(this.#master, key, masterContext(this.workspaceId, 'recovery'));
        requireCommit(
          await storageCall(() =>
            this.repository.writeMetadata(
              {
                ...row,
                revision: row.revision + 1,
                recoveryEnvelope: envelope,
                recoveryAcknowledgedAt: null,
                recoveryConfirmationHash: recoveryConfirmation(
                  this.#master!,
                  this.workspaceId,
                  envelope,
                  encoded.slice(-4),
                ),
                updatedAt: new Date().toISOString(),
              },
              row.revision,
            ),
          ),
        );
        return {
          key: encoded,
          text: `Sazuz Recovery Kit v1\nWorkspace: ${this.workspaceId}\nRecovery key: ${encoded}\nKeep this file offline. This replaces your previous recovery key.\n`,
          confirmationHint: 'Type the last four characters of the recovery key.',
        };
      } finally {
        clearBytes(key);
      }
    });
  }
  #purposeKey(purpose: SecretPurpose): Uint8Array {
    if (purpose !== 'authentication' && !this.#master) throw new VaultError('VAULT_LOCKED');
    return derivePurposeKey(
      purpose === 'authentication' ? this.authenticationKey : this.#master!,
      this.workspaceId,
      purpose === 'user' ? 'secrets' : purpose,
    );
  }
  async create(input: unknown, purpose: SecretPurpose = 'user'): Promise<SecretMetadata> {
    return this.#mutex.run(() => this.#createUnlocked(input, purpose));
  }
  async #createUnlocked(input: unknown, purpose: SecretPurpose): Promise<SecretMetadata> {
    const parsed = parseBoundary(createSecretSchema, input);
    // Browser-state documents stay in capsule callbacks; individual fields use a session redactor.
    if (purpose !== 'browser-profiles') secretRedactor.register(parsed.value);
    if (secretRedactor.redactText(parsed.name) !== parsed.name)
      throw new VaultError('VAULT_INVALID_INPUT');
    await readyCrypto();
    const key = this.#purposeKey(purpose);
    const plaintext = Buffer.from(parsed.value);
    const now = new Date().toISOString();
    const id = `sec_${ulid()}`;
    try {
      const row: StoredSecret = {
        id,
        workspaceId: this.workspaceId,
        purpose,
        name: parsed.name,
        createdBy: parsed.createdBy,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        maskedValue: '••••',
        envelope: seal(plaintext, key, secretContext(this.workspaceId, id, purpose)),
      };
      requireCommit(await storageCall(() => this.repository.insertSecret(row)));
      return metadata(row);
    } finally {
      clearBytes(key, plaintext);
    }
  }
  /** Execute an OAuth exchange with several user secrets and store its result under one lock. */
  async withSecrets<T>(
    references: readonly SecretReference[],
    execute: (
      values: ReadonlyMap<string, string>,
      store: (input: unknown) => Promise<SecretMetadata>,
    ) => Promise<T>,
  ): Promise<T> {
    const parsed = parseBoundary(z.array(secretReferenceSchema).min(1).max(16), references);
    return this.#mutex.run(async () => {
      const values = new Map<string, string>();
      const writes: Promise<PromiseSettledResult<SecretMetadata>>[] = [];
      let active = true;
      const store = (input: unknown) => {
        if (!active) return Promise.reject(new VaultError('VAULT_INVALID_INPUT'));
        const write = this.#createUnlocked(input, 'user');
        // Observe a store immediately, including when the exchange exits before awaiting it.
        writes.push(
          write.then(
            (value) => ({ status: 'fulfilled', value }),
            (reason: unknown) => ({ status: 'rejected', reason }),
          ),
        );
        return write;
      };
      const visit = async (index: number): Promise<T> => {
        const reference = parsed[index];
        if (!reference) return execute(values, store);
        return this.#withSecretUnlocked(reference as SecretReference, 'user', async (value) => {
          values.set(reference, value);
          return visit(index + 1);
        });
      };
      const [execution] = await Promise.allSettled([visit(0)]);
      active = false;
      const completed = await Promise.all(writes);
      values.clear();
      if (execution.status === 'rejected') throw execution.reason;
      const rejected = completed.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      return execution.value;
    });
  }
  async list(): Promise<SecretMetadata[]> {
    return (await storageCall(() => this.repository.listSecrets(this.workspaceId)))
      .map((row) => parseBoundary(storedSecretSchema, row, 'VAULT_DATA_INVALID'))
      .filter((row) => row.purpose === 'user')
      .map(metadata);
  }
  async withSecret<T>(
    reference: SecretReference,
    purpose: SecretPurpose,
    execute: (value: string) => Promise<T> | T,
  ): Promise<T> {
    return this.#mutex.run(() => this.#withSecretUnlocked(reference, purpose, execute));
  }
  async #withSecretUnlocked<T>(
    reference: SecretReference,
    purpose: SecretPurpose,
    execute: (value: string) => Promise<T> | T,
  ): Promise<T> {
    parseBoundary(secretReferenceSchema, reference);
    const id = parseBoundary(secretIdSchema, reference.slice('secret://'.length));
    await readyCrypto();
    const value = await storageCall(() => this.repository.readSecret(id));
    if (!value) throw new VaultError('VAULT_SECRET_NOT_FOUND');
    const row = parseBoundary(storedSecretSchema, value, 'VAULT_DATA_INVALID');
    if (row.workspaceId !== this.workspaceId || row.purpose !== purpose)
      throw new VaultError('VAULT_SECRET_NOT_FOUND');
    const key = this.#purposeKey(purpose);
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = unseal(row.envelope, key, secretContext(this.workspaceId, id, purpose));
      const resolved = Buffer.from(plaintext).toString('utf8');
      if (purpose !== 'browser-profiles') secretRedactor.register(resolved);
      return await execute(resolved);
    } finally {
      clearBytes(key, plaintext);
    }
  }
  async update(
    id: string,
    input: unknown,
    expectedRevision: number,
    purpose: SecretPurpose = 'user',
  ): Promise<SecretMetadata> {
    return this.#mutex.run(async () => {
      parseBoundary(secretIdSchema, id);
      const parsed = parseBoundary(updateSecretSchema, input);
      if (purpose !== 'browser-profiles') secretRedactor.register(parsed.value);
      if (secretRedactor.redactText(parsed.name) !== parsed.name)
        throw new VaultError('VAULT_INVALID_INPUT');
      const value = await storageCall(() => this.repository.readSecret(id));
      if (!value || value.workspaceId !== this.workspaceId || value.purpose !== purpose)
        throw new VaultError('VAULT_SECRET_NOT_FOUND');
      const key = this.#purposeKey(purpose);
      const plaintext = Buffer.from(parsed.value);
      try {
        const row = {
          ...value,
          name: parsed.name,
          revision: expectedRevision + 1,
          updatedAt: new Date().toISOString(),
          envelope: seal(plaintext, key, secretContext(this.workspaceId, id, purpose)),
        };
        requireCommit(await storageCall(() => this.repository.updateSecret(row, expectedRevision)));
        return metadata(row);
      } finally {
        clearBytes(key, plaintext);
      }
    });
  }
  async delete(id: string, purpose: SecretPurpose = 'user'): Promise<void> {
    parseBoundary(secretIdSchema, id);
    const row = await storageCall(() => this.repository.readSecret(id));
    if (!row || row.workspaceId !== this.workspaceId || row.purpose !== purpose)
      throw new VaultError('VAULT_SECRET_NOT_FOUND');
    requireCommit(await storageCall(() => this.repository.deleteSecret(id, this.workspaceId)));
  }
}

export function newWorkspaceId(): string {
  return `ws_${ulid()}`;
}
export function newInfrastructureKey(): Uint8Array {
  return randomBytes(32);
}
