import type { InfraConfig } from '@sazuz/config';
import { SazuzError } from '@sazuz/core';

/** Only a loopback database may be provisioned by the development command. */
export function developmentDatabaseEnvironment(
  config: InfraConfig,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (
    config.databaseUrl !== undefined ||
    !['127.0.0.1', 'localhost', '::1'].includes(config.databaseHost)
  ) {
    throw new SazuzError(
      'EXTERNAL_DB_UNAVAILABLE',
      'Configured external database is unavailable. Start it before running pnpm dev.',
    );
  }

  return {
    ...inherited,
    // Absolute paths keep Compose and host processes on the same credential file.
    SAZUZ_DATA_DIR: config.dataDir,
    SAZUZ_DATABASE_HOST: config.databaseHost === 'localhost' ? '127.0.0.1' : config.databaseHost,
    SAZUZ_DATABASE_PORT: String(config.databasePort),
    SAZUZ_DATABASE_NAME: config.databaseName,
    SAZUZ_DATABASE_USER: config.databaseUser,
  };
}
