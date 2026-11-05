import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

import { ConfigError } from './errors.js';

const hostSchema = z
  .string()
  .min(1)
  .max(253)
  .refine(
    (value) =>
      isIP(value) !== 0 ||
      /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*\.?$/i.test(
        value,
      ),
  );
const portSchema = z.number().int().min(1).max(65_535);
const environmentPortSchema = z
  .string()
  .regex(/^[1-9]\d{0,4}$/)
  .transform(Number)
  .pipe(portSchema);
const identifierSchema = z.string().regex(/^[a-z\d_][a-z\d_.-]{0,62}$/i);

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !containsControlCharacter(value));

function validDatabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    // Check encoding here so pg's URI parser cannot throw a raw credential-bearing URIError.
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    decodeURIComponent(url.pathname);
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      url.hostname.length > 0 &&
      url.pathname.length > 1 &&
      !url.pathname.slice(1).includes('/') &&
      url.hash === '' &&
      !containsControlCharacter(value) &&
      !value.includes(' ')
    );
  } catch {
    return false;
  }
}

function validServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname.length > 0 &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      !containsControlCharacter(value) &&
      !value.includes(' ')
    );
  } catch {
    return false;
  }
}

const databaseUrlSchema = z.string().max(8192).refine(validDatabaseUrl);
const serverUrlSchema = z.string().max(2048).refine(validServerUrl);

const environmentSchema = z.strictObject({
  SAZUZ_DATA_DIR: pathSchema.optional(),
  SAZUZ_DATABASE_HOST: hostSchema.optional(),
  SAZUZ_DATABASE_PORT: environmentPortSchema.optional(),
  SAZUZ_DATABASE_NAME: identifierSchema.optional(),
  SAZUZ_DATABASE_USER: identifierSchema.optional(),
  SAZUZ_DATABASE_URL: databaseUrlSchema.optional(),
  SAZUZ_SERVER_HOST: hostSchema.optional(),
  SAZUZ_SERVER_PORT: environmentPortSchema.optional(),
  SAZUZ_WEB_PORT: environmentPortSchema.optional(),
  SAZUZ_SERVER_URL: serverUrlSchema.optional(),
  SAZUZ_DOCKER_PROXY_URL: serverUrlSchema.optional(),
  SAZUZ_EGRESS_PROXY_URL: serverUrlSchema.optional(),
  SAZUZ_BROWSER_URL: serverUrlSchema.optional(),
  SAZUZ_WORKSPACE_VOLUME: identifierSchema.optional(),
  SAZUZ_EGRESS_SOCKET_VOLUME: identifierSchema.optional(),
});

export const infraConfigSchema = z.strictObject({
  dataDir: pathSchema.refine(isAbsolute),
  databaseHost: hostSchema,
  databasePort: portSchema,
  databaseName: identifierSchema,
  databaseUser: identifierSchema,
  databaseUrl: databaseUrlSchema.optional(),
  serverHost: hostSchema,
  serverPort: portSchema,
  webPort: portSchema,
  serverUrl: serverUrlSchema,
  dockerProxyUrl: serverUrlSchema.default('http://docker-socket-proxy:2375'),
  egressProxyUrl: serverUrlSchema.default('http://egress-proxy:8080'),
  browserUrl: serverUrlSchema.default('http://browser:7779'),
  workspaceVolume: identifierSchema.default('sazuz_sazuz_workspace'),
  egressSocketVolume: identifierSchema.default('sazuz_sazuz_egress'),
});

export type InfraConfig = z.infer<typeof infraConfigSchema>;

/** User/provider settings never come from environment variables. */
export function readInfraConfig(env: NodeJS.ProcessEnv = process.env): InfraConfig {
  const overrides = Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) => key.toUpperCase().startsWith('SAZUZ_') && value !== undefined,
    ),
  );
  const result = environmentSchema.safeParse(overrides);
  if (!result.success) {
    throw new ConfigError('INVALID_INFRA_CONFIG');
  }

  const environment = result.data;
  const serverHost = environment.SAZUZ_SERVER_HOST ?? '127.0.0.1';
  const serverPort = environment.SAZUZ_SERVER_PORT ?? 7778;
  const clientHost = serverHost === '0.0.0.0' || serverHost === '::' ? '127.0.0.1' : serverHost;
  const serverOrigin = `http://${isIP(clientHost) === 6 ? `[${clientHost}]` : clientHost}:${serverPort}`;
  const config = infraConfigSchema.safeParse({
    dataDir: resolve(environment.SAZUZ_DATA_DIR ?? resolve(process.cwd(), 'data')),
    databaseHost: environment.SAZUZ_DATABASE_HOST ?? '127.0.0.1',
    databasePort: environment.SAZUZ_DATABASE_PORT ?? 54329,
    databaseName: environment.SAZUZ_DATABASE_NAME ?? 'sazuz',
    databaseUser: environment.SAZUZ_DATABASE_USER ?? 'sazuz',
    ...(environment.SAZUZ_DATABASE_URL === undefined
      ? {}
      : { databaseUrl: environment.SAZUZ_DATABASE_URL }),
    serverHost,
    serverPort,
    webPort: environment.SAZUZ_WEB_PORT ?? 7777,
    serverUrl: environment.SAZUZ_SERVER_URL ?? serverOrigin,
    dockerProxyUrl: environment.SAZUZ_DOCKER_PROXY_URL,
    egressProxyUrl: environment.SAZUZ_EGRESS_PROXY_URL,
    browserUrl: environment.SAZUZ_BROWSER_URL,
    workspaceVolume: environment.SAZUZ_WORKSPACE_VOLUME,
    egressSocketVolume: environment.SAZUZ_EGRESS_SOCKET_VOLUME,
  });
  if (!config.success) {
    throw new ConfigError('INVALID_INFRA_CONFIG');
  }
  return config.data;
}

export function validateDataDir(value: string): string {
  const result = pathSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigError('INVALID_INFRA_CONFIG');
  }
  return resolve(result.data);
}
