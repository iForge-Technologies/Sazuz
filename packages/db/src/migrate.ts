import { resolve } from 'node:path';
import { SazuzError } from '@sazuz/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { Database } from './client.js';

export const MIGRATION_LOCK = 734_298_051;

export async function migrateDatabase(
  database: Database,
  migrationsFolder = resolve(process.cwd(), 'packages/db/migrations'),
): Promise<void> {
  const client = new pg.Client({
    ...database.pool.options,
    application_name: 'sazuz-migrations',
    connectionTimeoutMillis: 5000,
    statement_timeout: 120000,
    query_timeout: 135000,
    lock_timeout: 15000,
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await migrate(drizzle(client), { migrationsFolder });
    database.logger.info({ event: 'migrations.complete' }, 'Database migrations are current.');
  } catch {
    database.logger.error({ code: 'MIGRATION_FAILED' }, 'Database migration failed.');
    throw new SazuzError(
      'MIGRATION_FAILED',
      'Database migration failed; check database availability and migration files.',
    );
  } finally {
    if (connected) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
      } catch {
        // Closing a broken connection also releases its session-scoped advisory lock.
        database.logger.warn(
          { code: 'MIGRATION_LOCK_CONNECTION_LOST' },
          'Migration connection closed during lock release.',
        );
      }
    }
    await client.end();
  }
}
