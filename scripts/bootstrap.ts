import { ensureDatabasePassword, readInfraConfig, ConfigError } from '@sazuz/config';
import { createLogger } from '@sazuz/core';
import { secretRedactor } from '@sazuz/vault';

const logger = createLogger('bootstrap', secretRedactor);
try {
  const config = readInfraConfig();
  if (config.databaseUrl === undefined) await ensureDatabasePassword(config.dataDir);
  logger.info({ event: 'bootstrap.complete' }, 'Infrastructure credentials are ready.');
} catch (error: unknown) {
  logger.error(
    { code: error instanceof ConfigError ? error.code : 'BOOTSTRAP_FAILED' },
    'Infrastructure bootstrap failed.',
  );
  process.exitCode = 1;
}
