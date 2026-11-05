/* eslint-disable @typescript-eslint/require-await -- These in-memory repository doubles implement an asynchronous storage contract. */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Vault, newWorkspaceId } from './vault.js';
import { type StoredSecret, type VaultMetadata, type VaultRepository } from './contracts.js';
import { openBackup, openRollbackBackup, inspectBackup } from './backup.js';

function fixture() {
  let meta: VaultMetadata | null = null;
  const rows = new Map<string, StoredSecret>();
  const repository: VaultRepository = {
    async readMetadata() {
      return structuredClone(meta);
    },
    async writeMetadata(next, revision) {
      if ((meta?.revision ?? null) !== revision) return false;
      meta = structuredClone(next);
      return true;
    },
    async insertSecret(row) {
      if (rows.has(row.id)) return false;
      rows.set(row.id, structuredClone(row));
      return true;
    },
    async readSecret(id) {
      return structuredClone(rows.get(id) ?? null);
    },
    async listSecrets(workspaceId) {
      return structuredClone([...rows.values()].filter((row) => row.workspaceId === workspaceId));
    },
    async updateSecret(row, revision) {
      if (rows.get(row.id)?.revision !== revision) return false;
      rows.set(row.id, structuredClone(row));
      return true;
    },
    async deleteSecret(id, workspaceId) {
      return rows.get(id)?.workspaceId === workspaceId && rows.delete(id);
    },
  };
  const workspace = newWorkspaceId();
  const machine = randomBytes(32);
  const authentication = randomBytes(32);
  return {
    repository,
    rows,
    authentication,
    get meta() {
      return meta;
    },
    next: () => new Vault(repository, workspace, machine, authentication),
  };
}
const phrase = 'correct-horse-vault-passphrase';
describe('authenticated portable backups', () => {
  const id = 'bak_01AAAAAAAAAAAAAAAAAAAAAAAA',
    operationId = 'op_01BBBBBBBBBBBBBBBBBBBBBBBB';
  it('opens with the original passphrase or recovery key and clears capture/decryption buffers', async () => {
    const state = fixture(),
      vault = state.next(),
      kit = await vault.initialize(phrase, 'strict');
    const payload = Buffer.from('private archive payload');
    const bytes = await vault.backup(() => Promise.resolve(payload), {
      id,
      createdAt: new Date().toISOString(),
    });
    expect(payload.every((value) => value === 0)).toBe(true);
    expect(bytes.includes(Buffer.from('private archive payload'))).toBe(false);
    let consumed: Uint8Array | undefined;
    for (const credential of [phrase, kit.key]) {
      const value = await openBackup(bytes, credential, (value, header) => {
        consumed = value;
        expect(header.id).toBe(id);
        return Promise.resolve(Buffer.from(value).toString());
      });
      expect(value).toBe('private archive payload');
      expect(consumed!.every((byte) => byte === 0)).toBe(true);
    }
    await vault.lock();
    await expect(
      vault.backup(() => Promise.resolve(Buffer.alloc(1)), {
        id,
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
  });
  it('rejects wrong credentials, changed ciphertext/header, truncation and invalid KDF bounds', async () => {
    const state = fixture(),
      vault = state.next();
    await vault.initialize(phrase, 'auto');
    const bytes = await vault.backup(() => Promise.resolve(Buffer.from('contents')), {
      id,
      createdAt: new Date().toISOString(),
    });
    const use = () => Promise.resolve(true);
    for (const credential of [
      'wrong-passphrase-here',
      'X8_p11_bad',
      'sazuz-recovery-v1:' + 'A'.repeat(43),
    ])
      await expect(openBackup(bytes, credential, use)).rejects.toMatchObject({
        code: 'VAULT_DATA_INVALID',
      });
    const corrupted = Buffer.from(bytes);
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
    const altered = Buffer.from(bytes);
    const position = altered.indexOf(Buffer.from(id));
    altered[position + 5] = 67;
    for (const value of [corrupted, altered, bytes.subarray(0, bytes.length - 1), Buffer.alloc(12)])
      await expect(openBackup(value, phrase, use)).rejects.toMatchObject({
        code: 'VAULT_DATA_INVALID',
      });
    expect(() =>
      inspectBackup(Buffer.from(bytes.toString('latin1').replace('65536', '65535'), 'latin1')),
    ).toThrow();
  });
  it('binds unattended rollback to one operation and the local authentication key', async () => {
    const state = fixture(),
      vault = state.next();
    await vault.initialize(phrase, 'strict');
    const bytes = await vault.backup(() => Promise.resolve(Buffer.from('rollback data')), {
      id,
      createdAt: new Date().toISOString(),
      rollbackOperationId: operationId,
    });
    await vault.lock();
    expect(
      await openRollbackBackup(bytes, operationId, state.authentication, (data) =>
        Promise.resolve(Buffer.from(data).toString()),
      ),
    ).toBe('rollback data');
    await expect(
      openRollbackBackup(bytes, operationId, randomBytes(32), () => Promise.resolve(true)),
    ).rejects.toMatchObject({ code: 'VAULT_DATA_INVALID' });
    await expect(
      openRollbackBackup(bytes, 'op_01CCCCCCCCCCCCCCCCCCCCCCCC', state.authentication, () =>
        Promise.resolve(true),
      ),
    ).rejects.toThrow();
  });
  it('preserves operational callback failures without mislabeling them as credential errors', async () => {
    const state = fixture(),
      vault = state.next();
    await vault.initialize(phrase, 'auto');
    const bytes = await vault.backup(() => Promise.resolve(Buffer.from('data')), {
      id,
      createdAt: new Date().toISOString(),
    });
    const failure = new Error('database-test-failure');
    await expect(openBackup(bytes, phrase, () => Promise.reject(failure))).rejects.toBe(failure);
  });
});
describe('encrypted vault lifecycle', () => {
  it('isolates browser profiles from user secrets and requires the unlocked master key', async () => {
    const state = fixture(),
      vault = state.next();
    await vault.initialize(phrase, 'strict');
    const value = 'profile-state-canary-283711',
      saved = await vault.create(
        { name: 'Browser profile', value, createdBy: 'test' },
        'browser-profiles',
      );
    expect(await vault.list()).toEqual([]);
    expect(JSON.stringify([...state.rows.values()])).not.toContain(value);
    await expect(vault.withSecret(saved.reference, 'user', (value) => value)).rejects.toThrow();
    await expect(
      vault.update(saved.id, { name: 'Browser profile', value: 'changed-state-237819' }, 1),
    ).rejects.toThrow();
    await vault.lock();
    await expect(
      vault.withSecret(saved.reference, 'browser-profiles', (value) => value),
    ).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    await vault.unlock(phrase);
    expect(await vault.withSecret(saved.reference, 'browser-profiles', (value) => value)).toBe(
      value,
    );
    await vault.delete(saved.id, 'browser-profiles');
    expect(state.rows.size).toBe(0);
  });
  it.each(['auto', 'strict'] as const)(
    'persists only ciphertext and enforces %s restart behavior',
    async (mode) => {
      const state = fixture();
      const vault = state.next();
      expect(await vault.status()).toMatchObject({ initialized: false, locked: true });
      const kit = await vault.initialize(phrase, mode);
      await expect(vault.confirmRecovery('xxxx')).rejects.toMatchObject({
        code: 'VAULT_RECOVERY_UNCONFIRMED',
      });
      await vault.confirmRecovery(kit.key.slice(-4));
      const secret = await vault.create({
        name: 'canary',
        value: 'canary-sensitive-value-9135',
        createdBy: 'test',
      });
      expect(JSON.stringify(state.meta) + JSON.stringify([...state.rows.values()])).not.toContain(
        'canary-sensitive-value-9135',
      );
      expect(JSON.stringify(state.meta)).not.toContain(phrase);
      expect(JSON.stringify(state.meta)).not.toContain(kit.key);
      expect(await vault.list()).toEqual([secret]);
      const restarted = state.next();
      if (mode === 'auto') await restarted.unlock();
      else {
        await expect(restarted.unlock()).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
        await expect(restarted.unlock('wrong-vault-passphrase')).rejects.toMatchObject({
          code: 'VAULT_UNLOCK_FAILED',
        });
        await restarted.unlock(phrase);
      }
      expect(await restarted.withSecret(secret.reference, 'user', async (value) => value)).toBe(
        'canary-sensitive-value-9135',
      );
      await restarted.lock();
      await expect(
        restarted.withSecret(secret.reference, 'user', async () => true),
      ).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
      await restarted.unlock(kit.key);
      expect(await restarted.status()).toMatchObject({ recoveryConfirmed: true, locked: false });
    },
  );
  it('rotates secrets with version checks, masks even short values, and separates authentication secrets', async () => {
    const state = fixture();
    const vault = state.next();
    await vault.initialize(phrase, 'strict');
    const user = await vault.create({ name: 'short', value: 'ab', createdBy: 'test' });
    expect(user.maskedValue).not.toContain('ab');
    const auth = await vault.create(
      { name: 'auth', value: 'encrypted-authentication-value', createdBy: 'system' },
      'authentication',
    );
    expect(await vault.list()).toHaveLength(1);
    await expect(vault.withSecret(auth.reference, 'user', async () => true)).rejects.toMatchObject({
      code: 'VAULT_SECRET_NOT_FOUND',
    });
    await expect(vault.delete(auth.id)).rejects.toMatchObject({ code: 'VAULT_SECRET_NOT_FOUND' });
    const rotated = await vault.update(user.id, { name: 'new', value: 'new-sensitive-value' }, 1);
    expect(rotated.revision).toBe(2);
    await expect(
      vault.update(user.id, { name: 'stale', value: 'stale-sensitive-value' }, 1),
    ).rejects.toMatchObject({ code: 'VAULT_CONFLICT' });
    await vault.lock();
    expect(await vault.withSecret(auth.reference, 'authentication', async (value) => value)).toBe(
      'encrypted-authentication-value',
    );
    await vault.unlock(phrase);
    await vault.delete(user.id);
    await expect(vault.withSecret(user.reference, 'user', async () => true)).rejects.toMatchObject({
      code: 'VAULT_SECRET_NOT_FOUND',
    });
  });
  it('rejects tampered ciphertext and moving an envelope to a different row', async () => {
    const state = fixture();
    const vault = state.next();
    await vault.initialize(phrase, 'auto');
    const a = await vault.create({ name: 'a', value: 'sensitive-value-a', createdBy: 'test' });
    const b = await vault.create({ name: 'b', value: 'sensitive-value-b', createdBy: 'test' });
    state.rows.get(b.id)!.envelope = state.rows.get(a.id)!.envelope;
    await expect(vault.withSecret(b.reference, 'user', async () => true)).rejects.toMatchObject({
      code: 'VAULT_DECRYPTION_FAILED',
    });
    state.rows.get(a.id)!.envelope.nonce = 'invalid';
    await expect(vault.withSecret(a.reference, 'user', async () => true)).rejects.toMatchObject({
      code: 'VAULT_DATA_INVALID',
    });
  });
  it('regenerates lost recovery material and changes restart modes without losing secrets', async () => {
    const state = fixture();
    const vault = state.next();
    const old = await vault.initialize(phrase, 'auto');
    await expect(vault.initialize(phrase, 'auto')).rejects.toMatchObject({
      code: 'VAULT_ALREADY_INITIALIZED',
    });
    const kit = await vault.regenerateRecovery(phrase);
    await expect(state.next().unlock(old.key)).rejects.toMatchObject({
      code: 'VAULT_UNLOCK_FAILED',
    });
    await vault.confirmRecovery(kit.key.slice(-4));
    await vault.changeMode(phrase, 'strict');
    expect(state.meta?.machineEnvelope).toBeNull();
    await expect(state.next().unlock()).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    await vault.changeMode(phrase, 'auto');
    await state.next().unlock();
  });
  it('sanitizes storage failures and serializes locking behind execution', async () => {
    const state = fixture();
    const vault = state.next();
    await vault.initialize(phrase, 'auto');
    const secret = await vault.create({
      name: 'test',
      value: 'sensitive-value-lock',
      createdBy: 'test',
    });
    let finish: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const execution = vault.withSecret(secret.reference, 'user', async () => {
      entered();
      await blocked;
      return true;
    });
    await started;
    const locking = vault.lock();
    expect((await vault.status()).locked).toBe(false);
    finish();
    await execution;
    await locking;
    expect((await vault.status()).locked).toBe(true);
    state.repository.readMetadata = async () => {
      throw new Error('database-password-must-not-escape');
    };
    await expect(vault.status()).rejects.toMatchObject({
      code: 'VAULT_STORAGE_FAILED',
      message: 'The vault storage operation could not be completed.',
    });
  });
  it('rejects malformed inputs and cross-workspace metadata', async () => {
    const state = fixture();
    const vault = state.next();
    await expect(vault.unlock(phrase)).rejects.toMatchObject({ code: 'VAULT_NOT_INITIALIZED' });
    await expect(vault.initialize('short', 'auto')).rejects.toMatchObject({
      code: 'VAULT_INVALID_INPUT',
    });
    await vault.initialize(phrase, 'auto');
    await expect(
      vault.create({ name: 'x', value: '\ud800', createdBy: 'test' }),
    ).rejects.toMatchObject({ code: 'VAULT_INVALID_INPUT' });
    const other = new Vault(state.repository, newWorkspaceId(), randomBytes(32), randomBytes(32));
    await expect(other.status()).rejects.toMatchObject({ code: 'VAULT_DATA_INVALID' });
  });
  it('exchanges several user secrets and stores a new secret without releasing the vault lock', async () => {
    const state = fixture();
    const vault = state.next();
    await vault.initialize(phrase, 'auto');
    const verifier = await vault.create({
      name: 'PKCE',
      value: 'private-pkce-verifier-7294',
      createdBy: 'test',
    });
    const client = await vault.create({
      name: 'OAuth client',
      value: 'private-client-4379',
      createdBy: 'test',
    });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let scopeValues: ReadonlyMap<string, string> | undefined;
    let scopeStore: ((input: unknown) => Promise<unknown>) | undefined;
    const exchange = vault.withSecrets(
      [verifier.reference, client.reference],
      async (values, store) => {
        scopeValues = values;
        scopeStore = store;
        expect(values.get(verifier.reference)).toBe('private-pkce-verifier-7294');
        expect(values.get(client.reference)).toBe('private-client-4379');
        entered();
        await blocked;
        return store({
          name: 'OAuth refresh',
          value: 'private-refresh-token-1948',
          createdBy: 'test',
        });
      },
    );
    await started;
    const locking = vault.lock();
    expect((await vault.status()).locked).toBe(false);
    release();
    const refresh = await exchange;
    await locking;
    expect((await vault.status()).locked).toBe(true);
    expect(scopeValues?.size).toBe(0);
    await expect(
      scopeStore!({ name: 'Late', value: 'invalid-late-token', createdBy: 'test' }),
    ).rejects.toMatchObject({ code: 'VAULT_INVALID_INPUT' });
    expect(JSON.stringify([...state.rows.values()])).not.toContain('private-refresh-token-1948');
    await vault.unlock();
    expect(await vault.withSecret(refresh.reference, 'user', async (value) => value)).toBe(
      'private-refresh-token-1948',
    );
    const auth = await vault.create(
      { name: 'Authentication', value: 'private-auth-8186', createdBy: 'test' },
      'authentication',
    );
    await expect(vault.withSecrets([auth.reference], async () => true)).rejects.toMatchObject({
      code: 'VAULT_SECRET_NOT_FOUND',
    });
  });
  it('waits for an outstanding store and clears scoped values when an exchange fails', async () => {
    const state = fixture();
    const vault = state.next();
    await vault.initialize(phrase, 'auto');
    const verifier = await vault.create({
      name: 'PKCE',
      value: 'private-failed-exchange-verifier-1941',
      createdBy: 'test',
    });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    state.repository.insertSecret = async () => {
      entered();
      await blocked;
      throw new Error('private-storage-failure-detail');
    };
    let scopeValues: ReadonlyMap<string, string> | undefined;
    const failure = new Error('The OAuth exchange failed.');
    const exchange = vault.withSecrets([verifier.reference], (values, store) => {
      scopeValues = values;
      void store({ name: 'Refresh', value: 'private-unused-token-8732', createdBy: 'test' });
      return Promise.reject(failure);
    });
    const rejected = expect(exchange).rejects.toBe(failure);
    await started;
    const locking = vault.lock();
    expect((await vault.status()).locked).toBe(false);
    release();
    await rejected;
    await locking;
    expect(scopeValues?.size).toBe(0);
    expect((await vault.status()).locked).toBe(true);
    expect(await vault.list()).toHaveLength(1);
  });
});
