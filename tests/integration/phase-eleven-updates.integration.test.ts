import { mkdtemp, mkdir, cp, writeFile, readFile, rm, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  acquireActivity,
  installations,
  operations,
  operationGate,
  migrateDatabase,
  getControl,
  readSettings,
  saveSetting,
} from '@sazuz/db';
import {
  type createUpdates,
  readUpdate,
  updateLocal,
  OperationStorage,
  type Operations,
} from '@sazuz/ops';
import { registerBackups } from '../../apps/server/src/phase-eleven-backups.js';
import { registerUpdates } from '../../apps/server/src/phase-eleven-updates.js';
import { phaseFourFixture } from './phase-four-fixture.js';

const release = {
  format: 1 as const,
  version: '1.0.1',
  image: `ghcr.io/example/sazuz@sha256:${'a'.repeat(64)}`,
  notes: 'Reviewed candidate. Database migration test.',
};
const previousImage = `sha256:${'b'.repeat(64)}`;
describe('Phase 11 automatic update backup and recovery against PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof phaseFourFixture>>, backups: Operations;
  let service: ReturnType<typeof createUpdates>;
  let directory: string;
  let originalSession: Buffer, originalMachine: Buffer;
  const prepared = { requestId: randomUUID(), release, previousImage };
  beforeAll(async () => {
    f = await phaseFourFixture((app, runtime) => {
      backups = registerBackups(app, runtime, { background: false });
      service = registerUpdates(app, runtime, backups);
    });
    await f.db.orm.update(installations).set({ completedAt: new Date(), currentStep: 12 });
    await f.db.pool.query(
      "CREATE TABLE phase11_update_proof(id integer PRIMARY KEY, content text); INSERT INTO phase11_update_proof VALUES (1,'original')",
    );
    await mkdir(join(f.directory, 'workspace'), { recursive: true });
    await writeFile(join(f.directory, 'workspace/update-proof.txt'), 'original workspace');
    originalSession = await readFile(join(f.directory, 'secrets/session.key'));
    originalMachine = await readFile(join(f.directory, 'secrets/machine.key'));
    directory = await mkdtemp(join(tmpdir(), 'sazuz-update-migration-'));
  });
  afterAll(async () => {
    await f.db.pool.query(
      'DROP TABLE IF EXISTS phase11_update_proof; DROP TABLE IF EXISTS phase11_candidate_only',
    );
    await f.db.orm.update(operationGate).set({ operationId: null });
    await f.close();
    if (
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
      directory.includes('sazuz-update-migration-')
    )
      await rm(directory, { recursive: true, force: true });
  });
  it('requires owner/operator access and rejects unpinned releases before backup', async () => {
    expect((await f.request('GET', '/api/operations/updates', undefined, false)).statusCode).toBe(
      401,
    );
    expect((await f.request('GET', '/api/operations/updates')).json()).toBeNull();
    await expect(
      service.prepare(f.userId, {
        ...prepared,
        release: { ...release, image: 'ghcr.io/example/sazuz:latest' },
      }),
    ).rejects.toThrow();
    expect(await readUpdate(f.directory)).toBeNull();
    const settings = await readSettings(f.db);
    await saveSetting(f.db, {
      namespace: 'security',
      expectedVersion: settings.security.version,
      actorId: f.userId,
      value: {
        ...settings.security.value,
        rules: [{ id: 'deny-update', match: { tool: 'operations.update' }, action: 'deny' }],
      },
    });
    await expect(service.prepare(f.userId, prepared)).rejects.toMatchObject({ code: 'OPS_POLICY' });
    let current = await readSettings(f.db);
    await saveSetting(f.db, {
      namespace: 'security',
      expectedVersion: current.security.version,
      actorId: f.userId,
      value: {
        ...settings.security.value,
        rules: [{ id: 'deny-restore', match: { tool: 'operations.restore' }, action: 'deny' }],
      },
    });
    await expect(service.prepare(f.userId, prepared)).rejects.toMatchObject({ code: 'OPS_POLICY' });
    expect(await readUpdate(f.directory)).toBeNull();
    current = await readSettings(f.db);
    await saveSetting(f.db, {
      namespace: 'security',
      expectedVersion: current.security.version,
      actorId: f.userId,
      value: settings.security.value,
    });
  });
  it('takes one automatic encrypted backup and retains maintenance through host steps', async () => {
    const first = await service.prepare(f.userId, prepared);
    expect(first).toMatchObject({ stage: 'backed-up', previousImage });
    expect(await service.prepare(f.userId, prepared)).toEqual(first);
    expect(
      (await backups.status(f.userId)).backups.filter((row) => row.purpose === 'pre-update'),
    ).toHaveLength(1);
    await expect(
      service.prepare(f.userId, { ...prepared, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'OPS_UPDATE_STATE' });
    expect(await acquireActivity(f.db)).toBeNull();
    expect((await f.request('GET', '/api/projects')).statusCode).toBe(503);
    expect((await f.request('GET', '/api/operations/updates')).statusCode).toBe(200);
    const journal = (await readUpdate(f.directory))!;
    expect(
      (await new OperationStorage(f.directory).read(`${journal.backup!.id}.sazuz`))
        .subarray(0, 8)
        .toString(),
    ).toBe('SAZUZB1\n');
    expect(
      (await readdir(join(f.directory, 'secrets'))).filter((name) => name.startsWith('update-')),
    ).toHaveLength(1);
    await expect(
      updateLocal('checking', { database: f.db, config: f.runtime.config }),
    ).rejects.toMatchObject({ code: 'OPS_UPDATE_STATE' });
    await updateLocal('pulling', { database: f.db, config: f.runtime.config });
    await updateLocal('migrating', { database: f.db, config: f.runtime.config });
  });
  it('survives a real failing migration and loss of the database journal, restoring data, files and keys', async () => {
    await cp(resolve('packages/db/migrations'), directory, { recursive: true });
    const path = join(directory, 'meta/_journal.json');
    const meta = JSON.parse(await readFile(path, 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const last = meta.entries.at(-1)!;
    meta.entries.push({
      idx: last.idx + 1,
      version: '7',
      when: last.when + 1,
      tag: 'phase11_deliberate_failure',
      breakpoints: true,
    });
    await writeFile(path, JSON.stringify(meta));
    await writeFile(
      join(directory, 'phase11_deliberate_failure.sql'),
      'CREATE TABLE migration_partial(id integer); SELECT 1/0;',
    );
    // Earlier candidate work may already be committed, including changes outside a migration transaction.
    await f.db.pool.query(
      "ALTER TABLE phase11_update_proof ADD COLUMN candidate boolean; UPDATE phase11_update_proof SET content='candidate'; CREATE TABLE phase11_candidate_only(id integer)",
    );
    await writeFile(join(f.directory, 'workspace/update-proof.txt'), 'candidate workspace');
    await writeFile(
      join(f.directory, 'secrets/session.key'),
      randomBytes(32).toString('base64url'),
    );
    await writeFile(
      join(f.directory, 'secrets/machine.key'),
      randomBytes(32).toString('base64url'),
    );
    await expect(migrateDatabase(f.db, directory)).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
    });
    const historyCount = (
      await f.db.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
      )
    ).rows[0]!.count;
    // A previous candidate migration may have committed before this one failed.
    // Rollback compatibility must use the previous image's files, not this history.
    await f.db.pool.query(
      'INSERT INTO drizzle.__drizzle_migrations(hash,created_at) SELECT $1,max(created_at)+1 FROM drizzle.__drizzle_migrations',
      ['f'.repeat(64)],
    );
    await f.db.pool.query('DROP TABLE operations CASCADE');
    const restored = await updateLocal('rollback', { database: f.db, config: f.runtime.config });
    expect(restored.stage).toBe('restored');
    expect(
      (
        await f.db.pool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
        )
      ).rows[0]!.count,
    ).toBe(historyCount);
    expect(
      (await backups.status(f.userId)).backups.some(
        (backup) => backup.id === restored.backup!.id && backup.status === 'ready',
      ),
    ).toBe(true);
    expect(
      (await f.db.pool.query<{ content: string }>('SELECT content FROM phase11_update_proof'))
        .rows[0]?.content,
    ).toBe('original');
    expect(
      (
        await f.db.pool.query<{ missing: boolean }>(
          "SELECT to_regclass('phase11_candidate_only') IS NULL AND to_regclass('migration_partial') IS NULL AS missing",
        )
      ).rows[0]?.missing,
    ).toBe(true);
    expect(await readFile(join(f.directory, 'workspace/update-proof.txt'), 'utf8')).toBe(
      'original workspace',
    );
    expect(await readFile(join(f.directory, 'secrets/session.key'))).toEqual(originalSession);
    expect(await readFile(join(f.directory, 'secrets/machine.key'))).toEqual(originalMachine);
    expect(await acquireActivity(f.db)).toBeNull();
    expect((await getControl(f.db)).paused).toBe(true);
    // A completed rollback is not executed again when the host command is resumed.
    expect(
      await updateLocal('rollback', {
        database: f.db,
        config: f.runtime.config,
        snapshot: {
          dump: () => Promise.reject(new Error('No repeat')),
          sql: () => Promise.reject(new Error('No repeat')),
          restore: () => Promise.reject(new Error('No repeat')),
        },
      }),
    ).toEqual(restored);
    expect(
      (await updateLocal('finish-rollback', { database: f.db, config: f.runtime.config })).stage,
    ).toBe('rolled-back');
    const release = await acquireActivity(f.db);
    expect(release).not.toBeNull();
    await release?.();
    expect(
      (await readdir(join(f.directory, 'secrets'))).filter((name) => name.startsWith('update-')),
    ).toHaveLength(0);
  });
  it('activates only after the ordered stages and reconciles a lost acknowledgement without rolling back', async () => {
    const next = await service.prepare(f.userId, { ...prepared, requestId: randomUUID() });
    await updateLocal('pulling', { database: f.db, config: f.runtime.config });
    await updateLocal('migrating', { database: f.db, config: f.runtime.config });
    await updateLocal('checking', { database: f.db, config: f.runtime.config });
    expect((await service.activate()).stage).toBe('done');
    const journal = (await readUpdate(f.directory))!;
    await new OperationStorage(f.directory).write(
      'update.json',
      Buffer.from(JSON.stringify({ ...journal, stage: 'activation-intent', finishedAt: null })),
      true,
    );
    expect(
      (await updateLocal('reconcile', { database: f.db, config: f.runtime.config })).stage,
    ).toBe('done');
    expect((await service.activate()).stage).toBe('done');
    expect(
      (await f.db.orm.select().from(operations).where(eq(operations.id, next.operationId)))[0],
    ).toMatchObject({ status: 'done', stage: 'done' });
    await expect(
      updateLocal('rollback', { database: f.db, config: f.runtime.config }),
    ).rejects.toMatchObject({ code: 'OPS_UPDATE_STATE' });
  });
  it('records a locked-vault refusal without repeating backup or leaving admission closed', async () => {
    await f.runtime.vault.lock();
    const input = { ...prepared, requestId: randomUUID() };
    await expect(service.prepare(f.userId, input)).rejects.toMatchObject({
      code: 'OPS_UPDATE_STATE',
    });
    expect((await readUpdate(f.directory))?.stage).toBe('aborted');
    await f.runtime.vault.unlock('phase4-vault-passphrase-198723');
    expect((await service.prepare(f.userId, input)).stage).toBe('aborted');
    const release = await acquireActivity(f.db);
    expect(release).not.toBeNull();
    await release?.();
  });
  it('refuses activation when the maintenance evidence is missing', async () => {
    const next = await service.prepare(f.userId, { ...prepared, requestId: randomUUID() });
    await updateLocal('pulling', { database: f.db, config: f.runtime.config });
    await updateLocal('migrating', { database: f.db, config: f.runtime.config });
    await f.db.orm.update(operationGate).set({ operationId: null });
    await expect(
      updateLocal('checking', { database: f.db, config: f.runtime.config }),
    ).rejects.toMatchObject({ code: 'OPS_UPDATE_STATE' });
    const journal = (await readUpdate(f.directory))!;
    await new OperationStorage(f.directory).write(
      'update.json',
      Buffer.from(JSON.stringify({ ...journal, stage: 'activation-intent' })),
      true,
    );
    await expect(
      updateLocal('reconcile', { database: f.db, config: f.runtime.config }),
    ).rejects.toMatchObject({ code: 'OPS_UPDATE_ACTIVATION' });
    await expect(
      updateLocal('rollback', { database: f.db, config: f.runtime.config }),
    ).rejects.toMatchObject({ code: 'OPS_UPDATE_STATE' });
    await f.db.orm.update(operationGate).set({ operationId: next.operationId });
    expect(
      (await updateLocal('reconcile', { database: f.db, config: f.runtime.config })).stage,
    ).toBe('checking');
    await updateLocal('rollback', { database: f.db, config: f.runtime.config });
    await updateLocal('finish-rollback', { database: f.db, config: f.runtime.config });
  });
  it('recreates only the missing empty upload file after a reserved-upload crash', async () => {
    // The fresh-only check remains separate from the upload receipt and cannot be bypassed by an owner.
    await expect(
      backups.begin({ requestId: randomUUID(), bytes: 64, sha256: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'OPS_FRESH_REQUIRED' });
    const owner = (await f.runtime.state()).adminId;
    await f.db.orm.update(installations).set({ adminId: null, completedAt: null });
    try {
      const input = { requestId: randomUUID(), bytes: 64, sha256: '0'.repeat(64) };
      const upload = await backups.begin(input);
      await unlink(await backups.storage.path(`${upload.operation.id}.upload`));
      expect((await backups.begin(input)).receivedBytes).toBe(0);
      await backups.chunk(upload.operation.id, {
        offset: 0,
        data: Buffer.alloc(64).toString('base64'),
      });
      expect((await backups.begin(input)).receivedBytes).toBe(64);
    } finally {
      await f.db.orm.update(installations).set({ adminId: owner, completedAt: new Date() });
    }
  });
});
