import { readInfraConfig } from '@sazuz/config';
import { createLogger, SazuzError } from '@sazuz/core';
import { createDatabase, migrateDatabase, type Database } from '@sazuz/db';
import { secretRedactor } from '@sazuz/vault';

const logger = createLogger('migrate', secretRedactor);
let database: Database | undefined;
try {
  database = await createDatabase(readInfraConfig(), logger);
  await migrateDatabase(database);
} catch (error: unknown) {
  logger.error(
    { code: error instanceof SazuzError ? error.code : 'MIGRATION_FAILED' },
    'Migrations could not be applied.',
  );
  process.exitCode = 1;
} finally {
  try {
    await database?.close();
  } catch {
    logger.error({ code: 'DB_CLOSE_FAILED' }, 'Migration database connection could not close.');
    process.exitCode = 1;
  }
}
