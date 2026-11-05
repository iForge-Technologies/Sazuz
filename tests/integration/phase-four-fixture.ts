import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createProject, migrateDatabase, readHealth } from '@sazuz/db';
import { createApp } from '../../apps/server/src/app.js';
import { createPhaseOne } from '../../apps/server/src/phase-one.js';
import { registerPhaseOne } from '../../apps/server/src/phase-one-routes.js';
import { registerPhaseThree } from '../../apps/server/src/phase-three.js';
import { registerPhaseFour } from '../../apps/server/src/phase-four.js';
import { openIntegrationDatabase } from './database-fixture.js';

export async function phaseFourFixture(
  extend?: (
    app: Awaited<ReturnType<typeof createApp>>,
    runtime: Awaited<ReturnType<typeof createPhaseOne>>,
  ) => void,
  options: { maxConnections?: number } = {},
) {
  const fixture = await openIntegrationDatabase(options);
  const db = fixture.database;
  await migrateDatabase(db);
  const occupied = await db.pool.query<{ count: number }>(
    'SELECT ((SELECT count(*) FROM installation)+(SELECT count(*) FROM users)+(SELECT count(*) FROM worker_heartbeats)+(SELECT count(*) FROM cost_ledger))::int AS count',
  );
  if (occupied.rows[0]?.count !== 0) {
    await fixture.close();
    throw new Error('Use an empty dedicated Phase 4 API database.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'sazuz-phase4-api-'));
  const runtime = await createPhaseOne(db, { ...fixture.config, dataDir: directory });
  const app = await createApp({ logger: fixture.logger, health: () => readHealth(db) });
  registerPhaseOne(app, runtime);
  registerPhaseThree(app, runtime);
  registerPhaseFour(app, runtime);
  extend?.(app, runtime);
  const cookies = new Map<string, string>();
  async function request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    authenticated = true,
    origin = 'http://localhost:7777',
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
  async function requireOk(method: 'GET' | 'POST', url: string, payload: unknown) {
    const response = await request(method, url, payload);
    if (response.statusCode !== 200)
      throw new Error(`Fixture onboarding failed at ${url}: ${response.statusCode}`);
  }
  const token = (await readFile(join(directory, 'secrets/setup-token'), 'utf8')).trim();
  await requireOk('POST', '/api/setup/gate', { token });
  await requireOk('POST', '/api/setup/admin', {
    name: 'Knowledge owner',
    email: 'phase4@example.test',
    password: 'phase4-api-password-1876294',
  });
  await requireOk('POST', '/api/auth/sign-in/email', {
    email: 'phase4@example.test',
    password: 'phase4-api-password-1876294',
  });
  await requireOk('POST', '/api/vault/initialize', {
    passphrase: 'phase4-vault-passphrase-198723',
    mode: 'strict',
  });
  const userId = (await runtime.state()).adminId!;
  const project = await createProject(db, userId, { name: 'Phase 4 knowledge project' });
  return {
    ...fixture,
    db,
    app,
    runtime,
    request,
    cookieHeader: () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
    userId,
    projectId: project.id,
    directory,
    async close() {
      await app.close();
      await runtime.close();
      // This fixture reserved an empty *_test database before creating any of these records.
      await db.pool.query(
        'DELETE FROM installation; DELETE FROM setup_sessions; DELETE FROM settings_history; DELETE FROM settings; TRUNCATE TABLE audit_log, audit_chain_state; DELETE FROM vault_meta; DELETE FROM secrets; DELETE FROM cost_ledger; DELETE FROM users; DELETE FROM verifications; DELETE FROM auth_rate_limits; DELETE FROM security_rate_limits; DELETE FROM models; DELETE FROM worker_heartbeats; DELETE FROM execution_control; DELETE FROM execution_nonces; DELETE FROM channel_state; DELETE FROM channel_receipts; DELETE FROM delivery_intents',
      );
      await fixture.close();
      if (
        resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
        directory.includes('sazuz-phase4-api-')
      )
        await rm(directory, { recursive: true, force: true });
    },
  };
}
