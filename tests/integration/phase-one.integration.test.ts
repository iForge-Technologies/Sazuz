import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createDatabase,
  initializeSettings,
  installations,
  listenSettings,
  migrateDatabase,
  readSettings,
  readSettingsHistory,
  saveSetting,
  SettingsError,
} from '@sazuz/db';
import { recoveryResponseSchema, setupStatusSchema } from '@sazuz/config/contracts';
import { settingsDocumentSchema } from '@sazuz/config/settings';
import { ensureSetupToken } from '@sazuz/config';
import { createApp } from '../../apps/server/src/app.js';
import { createPhaseOne, type PhaseOne } from '../../apps/server/src/phase-one.js';
import { registerPhaseOne } from '../../apps/server/src/phase-one-routes.js';
import { openIntegrationDatabase, type IntegrationDatabase } from './database-fixture.js';

function totp(uri: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const encoded = new URL(uri).searchParams.get('secret')!;
  let bits = '';
  for (const character of encoded.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(character).toString(2).padStart(5, '0');
  const bytes = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', bytes).update(counter).digest();
  return ((digest.readUInt32BE(digest[19]! & 15) & 0x7fffffff) % 1_000_000)
    .toString()
    .padStart(6, '0');
}

describe('Phase 1 against real PostgreSQL', () => {
  let fixture: IntegrationDatabase;
  let runtime: PhaseOne;
  let app: Awaited<ReturnType<typeof createApp>>;
  let directory: string;
  let token: string;
  let created = false;
  const cookies = new Map<string, string>();
  const password = 'integration-admin-password-4723';
  const passphrase = 'integration-vault-passphrase-5839';
  const canary = 'sk-integration-canary-894657320184';
  const origin = 'http://localhost:7777';
  const health = {
    status: 'ok' as const,
    checkedAt: new Date().toISOString(),
    services: {
      database: { status: 'ok' as const, latencyMs: 1 },
      worker: { status: 'ok' as const, activeCount: 1, lastSeenAt: new Date().toISOString() },
    },
  };
  async function request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    authenticated = true,
  ) {
    const response = await app.inject({
      method,
      url,
      headers: {
        origin,
        'content-type': 'application/json',
        ...(authenticated
          ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') }
          : {}),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    if (authenticated)
      for (const cookie of response.cookies) cookies.set(cookie.name, cookie.value);
    return response;
  }
  async function restart() {
    await app.close();
    await runtime.close();
    runtime = await createPhaseOne(fixture.database, { ...fixture.config, dataDir: directory });
    app = await createApp({ logger: fixture.logger, health: () => Promise.resolve(health) });
    registerPhaseOne(app, runtime);
  }
  beforeAll(async () => {
    fixture = await openIntegrationDatabase();
    await migrateDatabase(fixture.database);
    if ((await fixture.database.orm.select().from(installations)).length)
      throw new Error('Use a fresh dedicated test database; an installation already exists.');
    const existing = await fixture.database.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM settings',
    );
    if (existing.rows[0]?.count !== 0)
      throw new Error('Use a fresh dedicated test database; settings already exist.');
    directory = await mkdtemp(join(tmpdir(), 'sazuz-phase1-integration-'));
    runtime = await createPhaseOne(fixture.database, { ...fixture.config, dataDir: directory });
    created = true;
    token = await ensureSetupToken(directory);
    app = await createApp({ logger: fixture.logger, health: () => Promise.resolve(health) });
    registerPhaseOne(app, runtime);
  });
  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    if (created) {
      // These tables were required empty before this test created the installation.
      await fixture.database.pool.query(
        'DELETE FROM installation; DELETE FROM setup_sessions; DELETE FROM settings_history; DELETE FROM settings; TRUNCATE TABLE audit_log, audit_chain_state; DELETE FROM vault_meta; DELETE FROM secrets; DELETE FROM users; DELETE FROM verifications; DELETE FROM auth_rate_limits; DELETE FROM security_rate_limits',
      );
    }
    await fixture?.close();
    if (
      directory &&
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
      directory.includes('sazuz-phase1-integration-')
    )
      await rm(directory, { recursive: true, force: true });
  });
  it('gates setup, creates one admin, preserves progress, and stores vault values as ciphertext', async () => {
    expect((await request('GET', '/api/settings', undefined, false)).statusCode).toBe(401);
    expect(
      (
        await request(
          'POST',
          '/api/setup/admin',
          { name: 'Owner', email: 'owner@example.test', password },
          false,
        )
      ).statusCode,
    ).toBe(401);
    expect((await request('POST', '/api/setup/gate', { token: 'wrong-token' })).statusCode).toBe(
      401,
    );
    expect((await request('POST', '/api/setup/gate', { token })).statusCode).toBe(200);
    expect((await request('POST', '/api/setup/step', { step: 2 })).statusCode).toBe(200);
    expect(
      (
        await request('POST', '/api/setup/admin', {
          name: 'Owner',
          email: 'owner@example.test',
          password,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request('POST', '/api/setup/admin', {
          name: 'Other',
          email: 'other@example.test',
          password,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await request('POST', '/api/vault/initialize', { passphrase, mode: 'strict' })).statusCode,
    ).toBe(401);
    const login = await request('POST', '/api/auth/sign-in/email', {
      email: 'owner@example.test',
      password,
    });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.body).not.toContain(password);
    const initialized = await request('POST', '/api/vault/initialize', {
      passphrase,
      mode: 'strict',
    });
    expect(initialized.statusCode, initialized.body).toBe(200);
    const kit = recoveryResponseSchema.parse(initialized.json<unknown>()).recoveryKit.text;
    const recovery = kit.match(/sazuz-recovery-v1:[A-Za-z0-9_-]+/)![0];
    expect(
      (await request('POST', '/api/vault/confirm-recovery', { characters: recovery.slice(-4) }))
        .statusCode,
    ).toBe(200);
    const stored = await request('POST', '/api/vault/secrets', {
      name: 'provider-canary',
      value: canary,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    expect(stored.body).not.toContain(canary);
    const handle = z.object({ reference: z.string() }).parse(stored.json<unknown>()).reference;
    expect((await request('POST', '/api/setup/step', { step: 4 })).statusCode).toBe(200);
    await restart();
    const status = setupStatusSchema.parse(
      (await request('GET', '/api/setup/status')).json<unknown>(),
    );
    expect(status.currentStep).toBe(4);
    expect(status.vault.locked).toBe(true);
    expect(status.authenticated).toBe(true);
    expect(
      (await request('POST', '/api/vault/secrets', { name: 'locked', value: canary })).statusCode,
    ).toBe(423);
    expect((await request('POST', '/api/vault/unlock', { passphrase })).statusCode).toBe(200);
    const document = settingsDocumentSchema.parse(
      (await request('GET', '/api/settings')).json<unknown>(),
    );
    const provider = {
      id: 'local',
      name: 'Local model',
      kind: 'ollama',
      baseUrl: 'http://localhost:11434',
      secretRef: handle,
      locality: 'local',
      enabled: true,
    };
    expect(
      (
        await request('POST', '/api/setup/step', {
          step: 5,
          namespace: 'providers',
          value: { items: [provider] },
          expectedVersion: document.providers.version,
        })
      ).statusCode,
    ).toBe(200);
    const dbRows = await fixture.database.pool.query('SELECT ciphertext, nonce FROM secrets');
    expect(JSON.stringify(dbRows.rows)).not.toContain(canary);
    expect(JSON.stringify(dbRows.rows)).not.toContain(passphrase);
    expect(fixture.logLines.join('')).not.toContain(canary);
    expect(fixture.logLines.join('')).not.toContain(password);
    const origins = await app.inject({
      method: 'POST',
      url: '/api/vault/lock',
      headers: {
        origin: 'https://attacker.example',
        'content-type': 'application/json',
        cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      },
      payload: '{}',
    });
    expect(origins.statusCode).toBe(403);
  });
  it('requires verified TOTP and consumes backup codes only once', async () => {
    const response = await request('POST', '/api/auth/two-factor/enable', { password });
    expect(response.statusCode, response.body).toBe(200);
    const provision = z
      .object({ totpURI: z.string(), backupCodes: z.array(z.string()) })
      .parse(response.json<unknown>());
    const verify = await request('POST', '/api/auth/two-factor/verify-totp', {
      code: totp(provision.totpURI),
    });
    expect(verify.statusCode, verify.body).toBe(200);
    const rows = await fixture.database.pool.query<{ secret: string; backup_codes: string }>(
      'SELECT secret, backup_codes FROM two_factors',
    );
    expect(rows.rows[0]?.secret).toMatch(/^secret:\/\//);
    expect(rows.rows[0]?.backup_codes).toMatch(/^secret:\/\//);
    expect((await request('POST', '/api/auth/sign-out', {})).statusCode).toBe(200);
    const login = await request('POST', '/api/auth/sign-in/email', {
      email: 'owner@example.test',
      password,
    });
    expect(login.json<unknown>()).toMatchObject({ twoFactorRedirect: true });
    expect((await request('GET', '/api/settings')).statusCode).toBe(401);
    expect(
      (await request('POST', '/api/auth/two-factor/verify-totp', { code: '000000' })).statusCode,
    ).not.toBe(200);
    expect(
      (await request('POST', '/api/auth/two-factor/verify-totp', { code: totp(provision.totpURI) }))
        .statusCode,
    ).toBe(200);
    await request('POST', '/api/auth/sign-out', {});
    await request('POST', '/api/auth/sign-in/email', { email: 'owner@example.test', password });
    const backup = await request('POST', '/api/auth/two-factor/verify-backup-code', {
      code: provision.backupCodes[0],
    });
    expect(backup.statusCode, backup.body).toBe(200);
    // Exercise a new sign-in window without bypassing Better Auth's real brute-force limiter.
    await delay(10_100);
    expect((await request('POST', '/api/auth/sign-out', {})).statusCode).toBe(200);
    expect(
      (await request('POST', '/api/auth/sign-in/email', { email: 'owner@example.test', password }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await request('POST', '/api/auth/two-factor/verify-backup-code', {
          code: provision.backupCodes[0],
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await request('POST', '/api/auth/two-factor/verify-backup-code', {
          code: provision.backupCodes[1],
        })
      ).statusCode,
    ).toBe(200);
  });
  it('reloads settings in under two seconds and rejects stale concurrent writes', async () => {
    const second = await createDatabase(fixture.config, fixture.logger);
    let applied = 0;
    const listener = await listenSettings(second, (document) => {
      applied = document.budgets.version;
    });
    try {
      const current = (await readSettings(fixture.database)).budgets;
      const start = performance.now();
      const saved = await saveSetting(fixture.database, {
        namespace: 'budgets',
        value: { ...current.value, monthlyUsd: 30 },
        expectedVersion: current.version,
        actorId: 'test',
      });
      while (applied < saved.version && performance.now() - start < 1900) await delay(10);
      expect(applied).toBe(saved.version);
      expect(performance.now() - start).toBeLessThan(2000);
      const race = await Promise.allSettled(
        [30, 40].map((monthlyUsd) =>
          saveSetting(fixture.database, {
            namespace: 'budgets',
            value: { ...current.value, monthlyUsd },
            expectedVersion: saved.version,
            actorId: 'test',
          }),
        ),
      );
      expect(race.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
      expect(race.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
      expect(
        (race.find((entry) => entry.status === 'rejected') as PromiseRejectedResult).reason,
      ).toBeInstanceOf(SettingsError);
      expect((await readSettingsHistory(fixture.database, 'budgets')).length).toBe(3);
      await initializeSettings(fixture.database, origin);
      expect((await readSettings(fixture.database)).budgets.version).toBe(saved.version + 1);
    } finally {
      await listener.close();
      await second.close();
    }
  });
  it('supports auto restart, finishes the wizard, and permanently revokes the setup token', async () => {
    expect(
      (await request('POST', '/api/vault/mode', { passphrase, mode: 'auto' })).statusCode,
    ).toBe(200);
    await restart();
    expect((await runtime.vault.status()).locked).toBe(false);
    for (let step = 6; step <= 12; step++)
      expect((await request('POST', '/api/setup/step', { step })).statusCode).toBe(200);
    expect((await request('POST', '/api/setup/complete', {})).statusCode).toBe(200);
    await expect(readFile(join(directory, 'secrets/setup-token'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await request('POST', '/api/setup/gate', { token })).statusCode).toBe(404);
    await restart();
    expect((await runtime.state()).completedAt).not.toBeNull();
    expect(
      (
        await request('POST', '/api/auth/sign-up/email', {
          email: 'intruder@example.test',
          name: 'Intruder',
          password,
        })
      ).statusCode,
    ).toBe(404);
  });
  it('recovers settings missed while the LISTEN connection is down', async () => {
    const second = await createDatabase(fixture.config, fixture.logger);
    const connection = await second.pool.connect();
    const backend = await connection.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = backend.rows[0]!.pid;
    connection.release();
    let applied = 0;
    const listener = await listenSettings(second, (document) => {
      applied = document.budgets.version;
    });
    try {
      const activity = await fixture.database.pool.query<{ query: string }>(
        'SELECT query FROM pg_stat_activity WHERE pid=$1',
        [pid],
      );
      expect(activity.rows[0]?.query).toBe('LISTEN settings_changed');
      await fixture.database.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      const current = (await readSettings(fixture.database)).budgets;
      const saved = await saveSetting(fixture.database, {
        namespace: 'budgets',
        value: { ...current.value, monthlyUsd: 70 },
        expectedVersion: current.version,
        actorId: 'test',
      });
      await expect.poll(() => applied, { timeout: 2000, interval: 10 }).toBe(saved.version);
      expect(listener.current?.budgets.value.monthlyUsd).toBe(70);
    } finally {
      await listener.close();
      await second.close();
    }
  });
  it('restricts operator recovery to the host and revokes old admin credentials and sessions', async () => {
    const advanced = (await readSettings(fixture.database)).advanced;
    await saveSetting(fixture.database, {
      namespace: 'advanced',
      value: { ...advanced.value, team: { template: 'custom', agents: ['cos'] } },
      expectedVersion: advanced.version,
      actorId: 'test',
    });
    await expect
      .poll(() => runtime.settings.advanced.version, { timeout: 2000 })
      .toBe(advanced.version + 1);
    const publicStatus = setupStatusSchema.parse(
      (await request('GET', '/api/setup/status', undefined, false)).json<unknown>(),
    );
    expect(publicStatus.settings).toBeNull();
    expect(publicStatus.team.template).toBe('personal-ops');
    const security = (await readSettings(fixture.database)).security;
    await saveSetting(fixture.database, {
      namespace: 'security',
      value: { ...security.value, requireTwoFactor: true },
      expectedVersion: security.version,
      actorId: 'test',
    });
    const replacement = 'reset-admin-password-6391';
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${runtime.plumbing.operatorKey}`,
    };
    expect(
      (await request('POST', '/api/operator/reset-admin', { password: replacement })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/operator/reset-admin',
          headers,
          remoteAddress: '192.0.2.10',
          payload: { password: replacement },
        })
      ).statusCode,
    ).toBe(403);
    const reset = await app.inject({
      method: 'POST',
      url: '/api/operator/reset-admin',
      headers,
      remoteAddress: '127.0.0.1',
      payload: { password: replacement },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect((await request('GET', '/api/settings')).statusCode).toBe(401);
    expect((await readSettings(fixture.database)).security.value.requireTwoFactor).toBe(false);
    await delay(10_100);
    expect(
      (
        await request('POST', '/api/auth/sign-in/email', {
          email: 'owner@example.test',
          password,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await request('POST', '/api/auth/sign-in/email', {
          email: 'owner@example.test',
          password: replacement,
        })
      ).statusCode,
    ).toBe(200);
    expect((await request('GET', '/api/settings')).statusCode).toBe(200);
    expect((await fixture.database.pool.query('SELECT id FROM two_factors')).rows).toHaveLength(0);
    await runtime.vault.lock();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/operator/unlock',
          headers,
          remoteAddress: '127.0.0.1',
          payload: { passphrase },
        })
      ).statusCode,
    ).toBe(200);
    expect((await runtime.vault.status()).locked).toBe(false);
    expect(fixture.logLines.join('')).not.toContain(replacement);
    expect(fixture.logLines.join('')).not.toContain(runtime.plumbing.operatorKey);
  });
});
