import { createWorkerId, healthSchema, workerIdSchema } from '@sazuz/core';
import {
  createDatabase,
  isWorkerHealthy,
  migrateDatabase,
  readHealth,
  recordHeartbeat,
  removeHeartbeat,
} from '@sazuz/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  dedicatedDatabaseConfig,
  IntegrationPrerequisiteError,
  openIntegrationDatabase,
  type IntegrationDatabase,
} from './database-fixture.js';

describe('integration database target', () => {
  it('accepts a dedicated test database URL', () => {
    expect(() =>
      dedicatedDatabaseConfig('postgresql://app:credential@localhost:5432/sazuz_test'),
    ).not.toThrow();
  });

  it.each([
    { label: 'production database', url: 'postgresql://app:credential@localhost:5432/sazuz' },
    {
      label: 'default system database',
      url: 'postgresql://app:credential@localhost:5432/postgres',
    },
    {
      label: 'misleading prefix',
      url: 'postgresql://app:credential@localhost:5432/test_production',
    },
    {
      label: 'encoded path separator',
      url: 'postgresql://app:credential@localhost:5432/production%2Fsazuz_test',
    },
    { label: 'malformed URI', url: 'not-a-url-canary-secret' },
  ])('refuses a $label without leaking its URI', ({ url }) => {
    let caught: unknown;
    try {
      dedicatedDatabaseConfig(url);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IntegrationPrerequisiteError);
    expect(caught).toMatchObject({ code: 'TEST_DATABASE_TARGET_INVALID' });
    expect(String(caught)).not.toContain(url);
    expect(caught).not.toHaveProperty('cause');
  });
});

describe('real PostgreSQL and pgvector persistence', () => {
  let fixture: IntegrationDatabase | undefined;
  let initialMigrationCount = 0;
  const ownedIds = new Set<string>();

  function context(): IntegrationDatabase {
    if (fixture === undefined) {
      throw new IntegrationPrerequisiteError('TEST_DATABASE_CONNECTION_FAILED');
    }
    return fixture;
  }

  function nextWorkerId(): string {
    const id = createWorkerId();
    ownedIds.add(id);
    return id;
  }

  beforeAll(async () => {
    fixture = await openIntegrationDatabase();
    const secondRunner = await createDatabase(fixture.config, fixture.logger);
    try {
      // The Testcontainers database is fresh here: both runners encounter the first migration.
      await Promise.all([migrateDatabase(fixture.database), migrateDatabase(secondRunner)]);
    } finally {
      await secondRunner.close();
    }
    const migrations = await fixture.database.pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations',
    );
    initialMigrationCount = migrations.rows[0]?.count ?? 0;
  });

  afterEach(async () => {
    if (fixture !== undefined && ownedIds.size > 0) {
      // Never truncate: a provided test database can contain unrelated tables or rows.
      await fixture.database.pool.query(
        'DELETE FROM worker_heartbeats WHERE id = ANY($1::text[])',
        [[...ownedIds]],
      );
      ownedIds.clear();
    }
  });

  afterAll(async () => {
    await fixture?.close();
  });

  it('repeats concurrent migrations without duplicating metadata or losing persisted rows', async () => {
    const { database } = context();
    const id = nextWorkerId();
    await recordHeartbeat(database, id);
    await migrateDatabase(database);
    await migrateDatabase(database);
    const result = await database.pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations',
    );

    expect(initialMigrationCount).toBeGreaterThan(0);
    expect(result.rows[0]?.count).toBe(initialMigrationCount);
    expect(await isWorkerHealthy(database, id)).toBe(true);
  });

  it('installs pgvector and executes a real vector distance operation', async () => {
    const { database } = context();
    const extension = await database.pool.query<{ version: string }>(
      "SELECT extversion AS version FROM pg_extension WHERE extname = 'vector'",
    );
    const result = await database.pool.query<{ distance: number }>(
      "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance",
    );

    expect(extension.rows).toHaveLength(1);
    expect(extension.rows[0]?.version).toMatch(/^\d+\.\d+/);
    expect(result.rows[0]?.distance).toBe(1);
  });

  it('reports a reachable database and a missing worker from actual persisted state', async () => {
    const health = await readHealth(context().database);

    expect(healthSchema.safeParse(health).success).toBe(true);
    expect(health).toMatchObject({
      status: 'degraded',
      services: {
        database: { status: 'ok' },
        worker: { status: 'missing', activeCount: 0, lastSeenAt: null },
      },
    });
    expect(await isWorkerHealthy(context().database, nextWorkerId())).toBe(false);
  });

  it('round-trips valid worker IDs and updates heartbeats without replacing process start time', async () => {
    const { database } = context();
    const id = nextWorkerId();
    expect(workerIdSchema.safeParse(id).success).toBe(true);
    await recordHeartbeat(database, id);
    const first = await database.pool.query<{ id: string; started_at: Date; last_seen_at: Date }>(
      'SELECT id, started_at, last_seen_at FROM worker_heartbeats WHERE id = $1',
      [id],
    );
    await database.pool.query(
      "UPDATE worker_heartbeats SET last_seen_at = now() - interval '30 seconds' WHERE id = $1",
      [id],
    );
    await recordHeartbeat(database, id);
    const second = await database.pool.query<{ id: string; started_at: Date; last_seen_at: Date }>(
      'SELECT id, started_at, last_seen_at FROM worker_heartbeats WHERE id = $1',
      [id],
    );

    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.id).toBe(id);
    expect(first.rows[0]?.started_at).toBeInstanceOf(Date);
    expect(second.rows[0]?.started_at).toEqual(first.rows[0]?.started_at);
    expect(second.rows[0]?.last_seen_at.getTime()).toBeGreaterThanOrEqual(
      first.rows[0]?.last_seen_at.getTime() ?? Number.POSITIVE_INFINITY,
    );
    expect(await isWorkerHealthy(database, id)).toBe(true);
  });

  it('remains ready with a second live worker and becomes missing after both are removed', async () => {
    const { database } = context();
    const first = nextWorkerId();
    const second = nextWorkerId();
    await Promise.all([recordHeartbeat(database, first), recordHeartbeat(database, second)]);
    expect(await readHealth(database)).toMatchObject({
      status: 'ok',
      services: { worker: { status: 'ok', activeCount: 2 } },
    });

    await removeHeartbeat(database, first);
    expect(await isWorkerHealthy(database, first)).toBe(false);
    expect(await isWorkerHealthy(database, second)).toBe(true);
    expect(await readHealth(database)).toMatchObject({
      status: 'ok',
      services: { worker: { status: 'ok', activeCount: 1 } },
    });

    await removeHeartbeat(database, second);
    await removeHeartbeat(database, second);
    expect(await readHealth(database)).toMatchObject({
      status: 'degraded',
      services: { worker: { status: 'missing', activeCount: 0 } },
    });
  });

  it('detects expired heartbeats without sleeping and recovers when the worker resumes', async () => {
    const { database } = context();
    const id = nextWorkerId();
    await recordHeartbeat(database, id);
    await database.pool.query(
      "UPDATE worker_heartbeats SET last_seen_at = now() - interval '30 seconds' WHERE id = $1",
      [id],
    );

    expect(await isWorkerHealthy(database, id)).toBe(false);
    expect(await readHealth(database)).toMatchObject({
      status: 'degraded',
      services: { database: { status: 'ok' }, worker: { status: 'stale', activeCount: 0 } },
    });
    await recordHeartbeat(database, id);
    expect(await isWorkerHealthy(database, id)).toBe(true);
    expect(await readHealth(database)).toMatchObject({
      status: 'ok',
      services: { worker: { status: 'ok', activeCount: 1 } },
    });
  });

  it('does not count future-dated heartbeats as ready', async () => {
    const { database } = context();
    const id = nextWorkerId();
    await recordHeartbeat(database, id);
    await database.pool.query(
      "UPDATE worker_heartbeats SET last_seen_at = now() + interval '30 seconds' WHERE id = $1",
      [id],
    );

    expect(await isWorkerHealthy(database, id)).toBe(false);
    expect(await readHealth(database)).toMatchObject({
      status: 'degraded',
      services: { worker: { status: 'stale', activeCount: 0 } },
    });
  });

  it('bounds retained operational state by pruning heartbeats older than a day', async () => {
    const { database } = context();
    const oldId = nextWorkerId();
    const currentId = nextWorkerId();
    await recordHeartbeat(database, oldId);
    await database.pool.query(
      "UPDATE worker_heartbeats SET last_seen_at = now() - interval '2 days' WHERE id = $1",
      [oldId],
    );
    await recordHeartbeat(database, currentId);
    const old = await database.pool.query<{ id: string }>(
      'SELECT id FROM worker_heartbeats WHERE id = $1',
      [oldId],
    );

    expect(old.rows).toHaveLength(0);
    expect(await isWorkerHealthy(database, currentId)).toBe(true);
  });

  it('rejects invalid IDs at both repository and database boundaries', async () => {
    const { database } = context();
    const invalidId = `invalid_${createWorkerId()}`;
    ownedIds.add(invalidId);

    await expect(recordHeartbeat(database, invalidId)).rejects.toMatchObject({
      code: 'WORKER_ID_INVALID',
    });
    await expect(removeHeartbeat(database, invalidId)).rejects.toMatchObject({
      code: 'WORKER_ID_INVALID',
    });
    await expect(isWorkerHealthy(database, invalidId)).rejects.toMatchObject({
      code: 'WORKER_ID_INVALID',
    });
    await expect(
      database.pool.query('INSERT INTO worker_heartbeats (id) VALUES ($1)', [invalidId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('closes real pooled connections and returns safe degraded health after dependency loss', async () => {
    const current = context();
    const independent = await createDatabase(current.config, current.logger);
    try {
      await independent.pool.query('SELECT 1');
    } finally {
      await independent.close();
    }
    expect(independent.pool.totalCount).toBe(0);
    await expect(independent.pool.query('SELECT 1')).rejects.toThrow();

    const health = await readHealth(independent);
    expect(healthSchema.safeParse(health).success).toBe(true);
    expect(health).toMatchObject({
      status: 'degraded',
      services: {
        database: { status: 'error' },
        worker: { status: 'unavailable', activeCount: 0, lastSeenAt: null },
      },
    });
    expect(await isWorkerHealthy(independent, nextWorkerId())).toBe(false);
    await expect(recordHeartbeat(independent, nextWorkerId())).rejects.toMatchObject({
      code: 'HEARTBEAT_FAILED',
      message: 'Worker could not update its heartbeat.',
    });
    await expect(removeHeartbeat(independent, nextWorkerId())).rejects.toMatchObject({
      code: 'HEARTBEAT_REMOVE_FAILED',
      message: 'Worker could not remove its heartbeat.',
    });
    expect(JSON.stringify(health)).not.toContain('connectionString');
    expect(
      current.config.databaseUrl !== undefined &&
        current.logLines.join('').includes(current.config.databaseUrl),
    ).toBe(false);
  });
});
