import { databaseConnection, type InfraConfig } from '@sazuz/config';
import { type createLogger, SazuzError } from '@sazuz/core';
import { secretRedactor } from '@sazuz/vault';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Logger = ReturnType<typeof createLogger>;

export interface Database {
  pool: pg.Pool;
  coordination: pg.Pool;
  orm: NodePgDatabase<typeof schema>;
  logger: Logger;
  close(): Promise<void>;
}

export async function createDatabase(
  config: InfraConfig,
  logger: Logger,
  options: { maxConnections?: number } = {},
): Promise<Database> {
  if (
    options.maxConnections !== undefined &&
    (!Number.isInteger(options.maxConnections) ||
      options.maxConnections < 5 ||
      options.maxConnections > 30)
  )
    throw new SazuzError('DB_INVALID_POOL', 'The database pool size is invalid.');
  const connection = await databaseConnection(config, secretRedactor);
  const pool = new pg.Pool({
    ...connection,
    max: options.maxConnections ?? 5,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 1_500,
    query_timeout: 2_000,
    application_name: 'sazuz',
  });
  pool.on('error', () => {
    logger.error({ code: 'DB_CONNECTION_LOST' }, 'An idle database connection was lost.');
  });
  // Long request leases must not exhaust the pool needed by their own application queries.
  const coordination = new pg.Pool({
    ...connection,
    max: 16,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 1_500,
    query_timeout: 2_000,
    application_name: 'sazuz-coordination',
  });
  coordination.on('error', () =>
    logger.error({ code: 'DB_COORDINATION_LOST' }, 'A maintenance lease connection was lost.'),
  );
  return {
    pool,
    coordination,
    orm: drizzle(pool, { schema }),
    logger,
    async close() {
      try {
        await Promise.all([pool.end(), coordination.end()]);
      } catch {
        throw new SazuzError('DB_CLOSE_FAILED', 'Could not close the database pool.');
      }
    },
  };
}
