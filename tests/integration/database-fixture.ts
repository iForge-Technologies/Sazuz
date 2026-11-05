import { randomBytes } from 'node:crypto';

import { readInfraConfig, type InfraConfig } from '@sazuz/config';
import { createLogger } from '@sazuz/core';
import { createDatabase, type Database } from '@sazuz/db';
import { secretRedactor } from '@sazuz/vault';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

const messages = {
  TEST_DATABASE_TARGET_INVALID:
    'Integration tests require a dedicated PostgreSQL database with a name ending in _test.',
  TEST_DATABASE_NOT_EMPTY:
    'The integration database contains existing worker heartbeats. Use an empty, dedicated test database.',
  TEST_DATABASE_CONNECTION_FAILED:
    'The integration database could not be reached. Check the dedicated test database and its credentials.',
  TESTCONTAINER_START_FAILED:
    'Could not start PostgreSQL/pgvector. Check Docker and image access, or provide SAZUZ_TEST_DATABASE_URL for a dedicated *_test database.',
  TEST_DATABASE_CLEANUP_FAILED:
    'The integration database connection or container could not be closed. Check the test infrastructure.',
} as const;

export class IntegrationPrerequisiteError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'IntegrationPrerequisiteError';
  }
}

/** Both the URI and the connected database must name a dedicated test database. */
export function dedicatedDatabaseConfig(value: string): InfraConfig {
  let config: InfraConfig;
  try {
    config = readInfraConfig({ SAZUZ_DATABASE_URL: value });
  } catch {
    throw new IntegrationPrerequisiteError('TEST_DATABASE_TARGET_INVALID');
  }
  const name = decodeURIComponent(new URL(value).pathname.slice(1));
  if (!/^[a-z][a-z0-9_]{0,57}_test$/i.test(name)) {
    throw new IntegrationPrerequisiteError('TEST_DATABASE_TARGET_INVALID');
  }
  return config;
}

export interface IntegrationDatabase {
  database: Database;
  config: InfraConfig;
  logger: ReturnType<typeof createLogger>;
  logLines: string[];
  close(): Promise<void>;
}

async function closeResources(
  database: Database | undefined,
  container: StartedPostgreSqlContainer | undefined,
): Promise<void> {
  let failed = false;
  try {
    await database?.close();
  } catch {
    failed = true;
  }
  try {
    await container?.stop();
  } catch {
    failed = true;
  }
  if (failed) {
    throw new IntegrationPrerequisiteError('TEST_DATABASE_CLEANUP_FAILED');
  }
}

/** No Docker-dependent check is skipped when infrastructure is absent. */
export async function openIntegrationDatabase(
  options: { maxConnections?: number } = {},
): Promise<IntegrationDatabase> {
  let container: StartedPostgreSqlContainer | undefined;
  let database: Database | undefined;
  const logLines: string[] = [];
  const logger = createLogger('integration-database', secretRedactor, {
    write(line) {
      logLines.push(line);
    },
  });

  let url = process.env['SAZUZ_TEST_DATABASE_URL'];
  if (url === undefined) {
    const password = randomBytes(32).toString('base64url');
    secretRedactor.register(password);
    try {
      container = await new PostgreSqlContainer('pgvector/pgvector:0.8.6-pg16-bookworm')
        .withDatabase('sazuz_test')
        .withUsername('sazuz_test')
        .withPassword(password)
        .start();
      url = container.getConnectionUri();
    } catch {
      throw new IntegrationPrerequisiteError('TESTCONTAINER_START_FAILED');
    }
  }

  try {
    const config = dedicatedDatabaseConfig(url);
    secretRedactor.register(url);
    // createDatabase also registers decoded credentials before constructing pg.Pool.
    database = await createDatabase(config, logger, options);
    const connected = await database.pool.query<{ name: string }>(
      'SELECT current_database() AS name',
    );
    const expectedName = decodeURIComponent(new URL(url).pathname.slice(1));
    if (connected.rows[0]?.name !== expectedName) {
      // This catches URI query parameters that might override the declared database.
      throw new IntegrationPrerequisiteError('TEST_DATABASE_TARGET_INVALID');
    }

    const table = await database.pool.query<{ name: string | null }>(
      "SELECT to_regclass('worker_heartbeats')::text AS name",
    );
    if (table.rows[0]?.name !== null) {
      const existing = await database.pool.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM worker_heartbeats',
      );
      if (existing.rows[0]?.count !== 0) {
        throw new IntegrationPrerequisiteError('TEST_DATABASE_NOT_EMPTY');
      }
    }

    let closed = false;
    const connection = database;
    return {
      database: connection,
      config,
      logger,
      logLines,
      async close() {
        if (!closed) {
          closed = true;
          await closeResources(connection, container);
        }
      },
    };
  } catch (error) {
    await closeResources(database, container);
    if (error instanceof IntegrationPrerequisiteError) {
      throw error;
    }
    throw new IntegrationPrerequisiteError('TEST_DATABASE_CONNECTION_FAILED');
  }
}
