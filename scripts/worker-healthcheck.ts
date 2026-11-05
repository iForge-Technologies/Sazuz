import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readInfraConfig } from '@sazuz/config';
import { createLogger } from '@sazuz/core';
import { createDatabase, isWorkerHealthy, type Database } from '@sazuz/db';
import { secretRedactor } from '@sazuz/vault';

const logger = createLogger('worker-healthcheck', secretRedactor);
let database: Database | undefined;
try {
  const id = await readFile(join(tmpdir(), 'sazuz-worker-id'), 'utf8');
  database = await createDatabase(readInfraConfig(), logger);
  process.exitCode = (await isWorkerHealthy(database, id)) ? 0 : 1;
} catch {
  logger.warn({ code: 'WORKER_NOT_READY' }, 'Worker is not ready.');
  process.exitCode = 1;
} finally {
  try {
    await database?.close();
  } catch {
    logger.error(
      { code: 'DB_CLOSE_FAILED' },
      'Worker probe could not close its database connection.',
    );
    process.exitCode = 1;
  }
}
