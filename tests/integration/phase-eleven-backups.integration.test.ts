import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import pg from 'pg';
import {
  createDatabase,
  createMission,
  getControl,
  installations,
  migrateDatabase,
  readHealth,
  readSettings,
  runs,
  saveSetting,
  sessions,
  settingsHistory,
  workKey,
  operations,
  backups,
  acquireActivity,
  operationGate,
  listenForRestore,
} from '@sazuz/db';
import { backupChecksum, type SecretReference } from '@sazuz/vault';
import { operationSchema, restoreUploadSchema } from '@sazuz/core/operations';
import { createOperations, postgresSnapshot, recoverOperations, type Operations } from '@sazuz/ops';
import { createApp } from '../../apps/server/src/app.js';
import { createPhaseOne } from '../../apps/server/src/phase-one.js';
import { registerPhaseOne } from '../../apps/server/src/phase-one-routes.js';
import { registerBackups } from '../../apps/server/src/phase-eleven-backups.js';
import { phaseFourFixture } from './phase-four-fixture.js';

function totp(uri: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const encoded = new URL(uri).searchParams.get('secret')!;
  const bits = [...encoded.replace(/=+$/, '').toUpperCase()]
    .map((character) => alphabet.indexOf(character).toString(2).padStart(5, '0'))
    .join('');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  return ((digest.readUInt32BE(digest[19]! & 15) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, '0');
}

describe('Phase 11 encrypted backup and fresh restore against PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof phaseFourFixture>>, source: Operations;
  let ciphertext: Buffer,
    recoveryKey: string,
    reference: SecretReference,
    authentication: SecretReference,
    browser: SecretReference;
  let runId: string, checkpoint: unknown, totpUri: string;
  const passphrase = 'phase4-vault-passphrase-198723';
  beforeAll(async () => {
    f = await phaseFourFixture((app, runtime) => {
      source = registerBackups(app, runtime, { background: false });
    });
    recoveryKey = (await f.runtime.vault.regenerateRecovery(passphrase)).key;
    await f.runtime.vault.confirmRecovery(recoveryKey.slice(-4));
    const enrollment = await f.request('POST', '/api/auth/two-factor/enable', {
      password: 'phase4-api-password-1876294',
    });
    expect(enrollment.statusCode, enrollment.body).toBe(200);
    totpUri = z.object({ totpURI: z.string() }).parse(enrollment.json<unknown>()).totpURI;
    const verified = await f.request('POST', '/api/auth/two-factor/verify-totp', {
      code: totp(totpUri),
    });
    expect(verified.statusCode, verified.body).toBe(200);
    reference = (
      await f.runtime.vault.create({
        name: 'Restore provider',
        value: 'backup-provider-canary-1973462',
        createdBy: f.userId,
      })
    ).reference;
    authentication = (
      await f.runtime.vault.create(
        { name: 'Restore authentication', value: 'backup-auth-canary-936829', createdBy: f.userId },
        'authentication',
      )
    ).reference;
    browser = (
      await f.runtime.vault.create(
        {
          name: 'Restore browser',
          value: '{"cookies":["private-browser-fixture"]}',
          createdBy: f.userId,
        },
        'browser-profiles',
      )
    ).reference;
    const settings = await readSettings(f.db);
    await saveSetting(f.db, {
      namespace: 'general',
      expectedVersion: settings.general.version,
      value: { ...settings.general.value, instanceName: 'Restored owner workspace' },
      actorId: f.userId,
    });
    await f.db.orm.update(installations).set({ completedAt: new Date(), currentStep: 12 });
    await mkdir(join(f.directory, 'workspace/empty'), { recursive: true, mode: 0o700 });
    await writeFile(join(f.directory, 'workspace/notes.txt'), 'Durable workspace file');
    const mission = await createMission(
      f.db,
      f.userId,
      {
        projectId: f.projectId,
        goal: 'Preserve this historical mission',
        requestId: randomUUID(),
      },
      { maxSteps: 5, maxCostUsd: 0, maxWallTimeSeconds: 60 },
    );
    runId = mission.run.id;
    checkpoint = { version: 1, fixture: 'retained-checkpoint' };
    await f.db.orm.update(runs).set({ checkpoint }).where(eq(runs.id, runId));
  });
  afterAll(async () => {
    await f?.close();
  });
  it('authorizes owned requests and creates only one backup for repeated request IDs', async () => {
    expect((await f.request('GET', '/api/backups', undefined, false)).statusCode).toBe(401);
    expect(
      (
        await f.request(
          'POST',
          '/api/backups',
          { requestId: randomUUID() },
          true,
          'https://attacker.example',
        )
      ).statusCode,
    ).toBe(403);
    const input = { requestId: randomUUID() };
    const result = await f.request('POST', '/api/backups', input);
    expect(result.statusCode, result.body).toBe(200);
    const receipt = operationSchema.parse(result.json<unknown>());
    expect(receipt).toMatchObject({ status: 'done' });
    expect((await f.request('POST', '/api/backups', input)).json<unknown>()).toEqual(receipt);
    const status = await source.status(f.userId);
    expect(status.backups).toHaveLength(1);
    ciphertext = (await source.download(f.userId, status.backups[0]!.id)).bytes;
    expect(ciphertext.includes(Buffer.from('backup-provider-canary-1973462'))).toBe(false);
    expect(ciphertext.includes(Buffer.from(passphrase))).toBe(false);
  }, 120000);
  async function target(failRestore = false) {
    const url = new URL(f.config.databaseUrl!);
    const name = `sazuz_restore_${randomUUID().replaceAll('-', '').slice(0, 12)}_test`;
    await f.db.pool.query(`CREATE DATABASE ${name}`);
    url.pathname = '/' + name;
    const directory = await mkdtemp(join(tmpdir(), 'sazuz-restore-test-'));
    const config = { ...f.config, databaseUrl: url.toString(), dataDir: directory };
    const db = await createDatabase(config, f.logger);
    await migrateDatabase(db);
    let workerReloadRequested = false;
    const listener = await listenForRestore(db, () => {
      workerReloadRequested = true;
    });
    let runtime = await createPhaseOne(db, config);
    let app = await createApp({ logger: f.logger, health: () => readHealth(db) });
    let restarted = false;
    registerPhaseOne(app, runtime);
    const native = postgresSnapshot(config);
    let service = registerBackups(app, runtime, {
      background: false,
      ...(failRestore
        ? {
            snapshot: {
              ...native,
              restore: (sql: Uint8Array, suffix: string) =>
                native.restore(
                  sql,
                  suffix + '\nSELECT * FROM intentionally_missing_restore_table;',
                ),
            },
          }
        : {}),
      restored: () => {
        restarted = true;
      },
    });
    const cookies = new Map<string, string>();
    async function request(
      method: 'GET' | 'POST',
      path: string,
      payload?: unknown,
      authenticated = true,
    ) {
      const result = await app.inject({
        method,
        url: path,
        headers: {
          origin: 'http://localhost:7777',
          'content-type': 'application/json',
          cookie: authenticated
            ? [...cookies].map(([key, value]) => `${key}=${value}`).join('; ')
            : '',
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
      if (authenticated)
        for (const cookie of result.cookies) cookies.set(cookie.name, cookie.value);
      return result;
    }
    await writeFile(join(directory, 'secrets/db-password'), 'fresh-target-password-fixture', {
      mode: 0o600,
    });
    const token = (await readFile(join(directory, 'secrets/setup-token'), 'utf8')).trim();
    expect((await request('POST', '/api/setup/gate', { token })).statusCode).toBe(200);
    return {
      db,
      config,
      directory,
      request,
      get runtime() {
        return runtime;
      },
      get service() {
        return service;
      },
      get restarted() {
        return restarted;
      },
      get workerReloadRequested() {
        return workerReloadRequested;
      },
      async restart() {
        await app.close();
        await runtime.close();
        runtime = await createPhaseOne(db, config);
        app = await createApp({ logger: f.logger, health: () => readHealth(db) });
        registerPhaseOne(app, runtime);
        service = registerBackups(app, runtime, { background: false });
        await recoverOperations(db);
      },
      async close() {
        await app.close();
        await runtime.close();
        await listener.close();
        await db.close();
        if (!/^sazuz_restore_[a-f0-9]{12}_test$/.test(name))
          throw new Error('Unsafe test database cleanup');
        // Dropping a database may wait for a PostgreSQL checkpoint. This admin
        // cleanup must not inherit the application's 1.5-second query limit.
        const cleanup = new pg.Client({
          ...f.db.pool.options,
          statement_timeout: 15000,
          query_timeout: 20000,
          application_name: 'sazuz-test-cleanup',
        });
        try {
          await cleanup.connect();
          await cleanup.query(`DROP DATABASE ${name} WITH (FORCE)`);
        } finally {
          await cleanup.end();
        }
        if (
          resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
          directory.includes('sazuz-restore-test-')
        )
          await rm(directory, { recursive: true, force: true });
      },
    };
  }
  async function upload(t: Awaited<ReturnType<typeof target>>, bytes = ciphertext) {
    const input = { requestId: randomUUID(), bytes: bytes.length, sha256: backupChecksum(bytes) };
    const begin = await t.request('POST', '/api/setup/restore', input);
    expect(begin.statusCode, begin.body).toBe(200);
    const id = restoreUploadSchema.parse(begin.json<unknown>()).operation.id;
    expect(
      restoreUploadSchema.parse(
        (await t.request('POST', '/api/setup/restore', input)).json<unknown>(),
      ).operation.id,
    ).toBe(id);
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      const part = { offset, data: bytes.subarray(offset, offset + 65536).toString('base64') };
      const result = await t.request('POST', `/api/setup/restore/${id}/chunks`, part);
      expect(result.statusCode, result.body).toBe(200);
      if (offset === 0) {
        expect((await t.request('POST', `/api/setup/restore/${id}/chunks`, part)).statusCode).toBe(
          200,
        );
        expect(
          (
            await t.request('POST', `/api/setup/restore/${id}/chunks`, {
              ...part,
              data: Buffer.from('changed').toString('base64'),
            })
          ).statusCode,
        ).toBe(400);
      }
    }
    return id;
  }
  it.each(['passphrase', 'recovery'] as const)(
    'restores a fresh database, settings history, keys, vault, workspace and checkpoints using %s',
    async (credential) => {
      const t = await target();
      try {
        expect(
          (
            await t.request(
              'POST',
              '/api/setup/restore',
              {
                requestId: randomUUID(),
                bytes: ciphertext.length,
                sha256: backupChecksum(ciphertext),
              },
              false,
            )
          ).statusCode,
        ).toBe(401);
        const id = await upload(t);
        const restored = await t.request('POST', `/api/setup/restore/${id}/complete`, {
          credential: credential === 'passphrase' ? passphrase : recoveryKey,
          confirm: 'restore',
        });
        expect(restored.statusCode, restored.body).toBe(200);
        expect(operationSchema.parse(restored.json<unknown>()).status).toBe('done');
        expect((await t.db.orm.select().from(sessions)).length).toBe(0);
        expect((await getControl(t.db)).paused).toBe(true);
        expect((await t.db.orm.select().from(runs).where(eq(runs.id, runId)))[0]).toMatchObject({
          checkpoint,
          status: 'cancelled',
          claimKey: null,
        });
        expect((await t.db.orm.select().from(settingsHistory)).length).toBeGreaterThan(12);
        expect(await readFile(join(t.directory, 'workspace/notes.txt'), 'utf8')).toBe(
          'Durable workspace file',
        );
        expect(await readFile(join(t.directory, 'secrets/db-password'), 'utf8')).toBe(
          'fresh-target-password-fixture',
        );
        expect(await readFile(join(t.directory, 'secrets/session.key'))).toEqual(
          await readFile(join(f.directory, 'secrets/session.key')),
        );
        await delay(300);
        expect(t.restarted).toBe(true);
        expect(t.workerReloadRequested).toBe(true);
        await t.restart();
        await t.runtime.vault.unlock(credential === 'passphrase' ? passphrase : recoveryKey);
        expect(await t.runtime.vault.withSecret(reference, 'user', (value) => value)).toBe(
          'backup-provider-canary-1973462',
        );
        expect(
          await t.runtime.vault.withSecret(authentication, 'authentication', (value) => value),
        ).toBe('backup-auth-canary-936829');
        expect(
          await t.runtime.vault.withSecret(browser, 'browser-profiles', (value) => value),
        ).toContain('private-browser-fixture');
        const login = await t.request('POST', '/api/auth/sign-in/email', {
          email: 'phase4@example.test',
          password: 'phase4-api-password-1876294',
        });
        expect(login.statusCode, login.body).toBe(200);
        expect(login.json<unknown>()).toMatchObject({ twoFactorRedirect: true });
        const verification = await t.request('POST', '/api/auth/two-factor/verify-totp', {
          code: totp(totpUri),
        });
        expect(verification.statusCode, verification.body).toBe(200);
        expect((await t.request('GET', '/api/settings')).statusCode).toBe(200);
        expect(
          (
            await t.request('POST', '/api/setup/restore', {
              requestId: randomUUID(),
              bytes: ciphertext.length,
              sha256: backupChecksum(ciphertext),
            })
          ).statusCode,
        ).toBe(404);
      } finally {
        await t.close();
      }
    },
    120000,
  );
  it('preserves the original database on an import failure, restarts after key changes and safely accepts an explicit retry', async () => {
    const t = await target(true);
    try {
      const id = await upload(t);
      const response = await t.request('POST', `/api/setup/restore/${id}/complete`, {
        credential: passphrase,
        confirm: 'restore',
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.body).toContain('OPS_DATABASE');
      expect((await t.runtime.state()).adminId).toBeNull();
      expect((await t.request('POST', '/api/setup/admin', {})).statusCode).toBe(503);
      await delay(300);
      expect(t.restarted).toBe(true);
      await t.restart();
      const retry = await t.request('POST', `/api/setup/restore/${id}/complete`, {
        credential: recoveryKey,
        confirm: 'restore',
      });
      expect(retry.statusCode, retry.body).toBe(200);
      expect((await t.runtime.state()).adminId).toBe(f.userId);
    } finally {
      await t.close();
    }
  }, 120000);
  it('rejects wrong credentials and authenticated archive corruption before changing live data or keys', async () => {
    const t = await target();
    try {
      const original = await readFile(join(t.directory, 'secrets/session.key'));
      const id = await upload(t);
      const rejected = await t.request('POST', `/api/setup/restore/${id}/complete`, {
        credential: 'incorrect-vault-passphrase',
        confirm: 'restore',
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.body).toContain('OPS_CREDENTIAL');
      const corrupt = Buffer.from(ciphertext);
      corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
      const tampered = await upload(t, corrupt);
      expect(
        (
          await t.request('POST', `/api/setup/restore/${tampered}/complete`, {
            credential: passphrase,
            confirm: 'restore',
          })
        ).statusCode,
      ).toBe(400);
      expect((await t.runtime.state()).adminId).toBeNull();
      expect(await readFile(join(t.directory, 'secrets/session.key'))).toEqual(original);
      expect(f.logLines.join('')).not.toMatch(
        /incorrect-vault-passphrase|backup-provider-canary-1973462/,
      );
    } finally {
      await t.close();
    }
  }, 120000);
  it('drains active request leases and never captures while a claim remains', async () => {
    const release = (await acquireActivity(f.db))!;
    let dumps = 0;
    const native = postgresSnapshot(f.runtime.config);
    const checked = createOperations({
      database: f.db,
      config: f.runtime.config,
      vault: f.runtime.vault,
      snapshot: {
        ...native,
        dump: () => {
          dumps++;
          return native.dump();
        },
      },
    });
    const pending = checked.create(f.userId, { requestId: randomUUID() });
    await delay(150);
    expect(dumps).toBe(0);
    expect(await acquireActivity(f.db)).toBeNull();
    await release();
    expect((await pending).status).toBe('done');
    await f.db.orm.update(runs).set({ claimKey: randomUUID() }).where(eq(runs.id, runId));
    expect(await checked.create(f.userId, { requestId: randomUUID() })).toMatchObject({
      status: 'failed',
      code: 'OPS_BUSY',
    });
    await f.db.orm.update(runs).set({ claimKey: null }).where(eq(runs.id, runId));
    expect(dumps).toBe(1);
  }, 120000);
  it('deduplicates scheduled ticks and records locked-vault failures; restrictive policies block deletion', async () => {
    let document = await readSettings(f.db);
    await saveSetting(f.db, {
      namespace: 'backups',
      expectedVersion: document.backups.version,
      value: { ...document.backups.value, enabled: true, schedule: '* * * * *', prune: false },
      actorId: f.userId,
    });
    const now = new Date();
    now.setUTCSeconds(0, 0);
    const before = (await f.db.orm.select().from(backups)).length;
    await source.tick(now);
    await source.tick(now);
    expect((await f.db.orm.select().from(backups)).length).toBe(before + 1);
    await f.runtime.vault.lock();
    await source.tick(new Date(now.getTime() + 60000));
    expect((await source.status(f.userId)).operations[0]).toMatchObject({
      status: 'failed',
      code: 'VAULT_LOCKED',
    });
    await f.runtime.vault.unlock(passphrase);
    document = await readSettings(f.db);
    await saveSetting(f.db, {
      namespace: 'security',
      expectedVersion: document.security.version,
      actorId: f.userId,
      value: {
        ...document.security.value,
        rules: [
          {
            id: 'no-backup-delete',
            scope: { type: 'global' },
            match: { tool: 'operations.prune' },
            when: [],
            action: 'deny',
          },
        ],
      },
    });
    await saveSetting(f.db, {
      namespace: 'backups',
      expectedVersion: document.backups.version,
      actorId: f.userId,
      value: { ...document.backups.value, prune: true, retentionDays: 1 },
    });
    await expect(source.tick(new Date(now.getTime() + 2 * 86400000))).rejects.toMatchObject({
      code: 'OPS_POLICY',
    });
    expect(
      (await f.db.orm.select().from(backups)).every((backup) => backup.status === 'ready'),
    ).toBe(true);
  }, 120000);
  it('refuses a source database whose migration history differs from the installed files', async () => {
    const history = await f.db.pool.query<{ id: number; hash: string }>(
      'SELECT id,hash FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 1',
    );
    const first = history.rows[0]!;
    const before = (await source.status(f.userId)).backups.length;
    await f.db.pool.query('UPDATE drizzle.__drizzle_migrations SET hash=$1 WHERE id=$2', [
      'f'.repeat(64),
      first.id,
    ]);
    try {
      const result = await source.create(f.userId, { requestId: randomUUID() });
      expect(result).toMatchObject({ status: 'failed', code: 'OPS_MIGRATIONS' });
      expect((await source.status(f.userId)).backups).toHaveLength(before);
    } finally {
      await f.db.pool.query('UPDATE drizzle.__drizzle_migrations SET hash=$1 WHERE id=$2', [
        first.hash,
        first.id,
      ]);
    }
  });
  it('retains interrupted operation evidence and reopens admission without rerunning the snapshot', async () => {
    const id = workKey('op');
    await f.db.orm.insert(operations).values({
      id,
      kind: 'backup',
      requestKey: randomUUID(),
      inputHash: 'a'.repeat(64),
      status: 'running',
      userId: f.userId,
    });
    await f.db.orm.update(operationGate).set({ operationId: id });
    await recoverOperations(f.db);
    expect((await f.db.orm.select().from(operations).where(eq(operations.id, id)))[0]?.status).toBe(
      'interrupted',
    );
    expect((await f.db.orm.select().from(operationGate))[0]?.operationId).toBeNull();
    expect(z.string().parse((await source.status(f.userId)).operations[0]?.code)).toBe(
      'OPS_INTERRUPTED',
    );
  });
});
