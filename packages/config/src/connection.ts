import { type SecretRedactor } from '@sazuz/vault';

import { readDatabasePassword } from './credentials.js';
import { ConfigError } from './errors.js';
import { infraConfigSchema, type InfraConfig } from './infra.js';

export type DatabaseConnection =
  | { host: string; port: number; database: string; user: string; password: string }
  | { connectionString: string };

/** Register credentials before constructing a driver or allowing driver errors to escape. */
export async function databaseConnection(
  config: InfraConfig,
  redactor: SecretRedactor,
): Promise<DatabaseConnection> {
  const validated = infraConfigSchema.safeParse(config);
  if (!validated.success) {
    throw new ConfigError('INVALID_INFRA_CONFIG');
  }
  const settings = validated.data;
  if (settings.databaseUrl !== undefined) {
    const url = new URL(settings.databaseUrl);
    redactor.register(settings.databaseUrl);
    if (url.password !== '') {
      redactor.register(decodeURIComponent(url.password));
    }
    for (const [key, value] of url.searchParams) {
      if (value !== '' && /(?:password|passwd|passphrase|secret|token|key)$/i.test(key)) {
        redactor.register(value);
      }
    }
    return { connectionString: settings.databaseUrl };
  }

  const password = await readDatabasePassword(settings.dataDir);
  redactor.register(password);
  return {
    host: settings.databaseHost,
    port: settings.databasePort,
    database: settings.databaseName,
    user: settings.databaseUser,
    password,
  };
}
