import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigError, readInfraConfig } from './index.js';

describe('readInfraConfig', () => {
  it('starts with zero environment variables and safe typed defaults', () => {
    expect(readInfraConfig({})).toEqual({
      dataDir: resolve(process.cwd(), 'data'),
      databaseHost: '127.0.0.1',
      databasePort: 54329,
      databaseName: 'sazuz',
      databaseUser: 'sazuz',
      serverHost: '127.0.0.1',
      serverPort: 7778,
      webPort: 7777,
      serverUrl: 'http://127.0.0.1:7778',
      dockerProxyUrl: 'http://docker-socket-proxy:2375',
      egressProxyUrl: 'http://egress-proxy:8080',
      browserUrl: 'http://browser:7779',
      workspaceVolume: 'sazuz_sazuz_workspace',
      egressSocketVolume: 'sazuz_sazuz_egress',
    });
  });

  it('accepts only infrastructure overrides and resolves a relative data directory', () => {
    const config = readInfraConfig({
      SAZUZ_DATA_DIR: 'custom-data',
      SAZUZ_DATABASE_HOST: 'postgres',
      SAZUZ_DATABASE_PORT: '5432',
      SAZUZ_DATABASE_NAME: 'sazuz_test',
      SAZUZ_DATABASE_USER: 'sazuz_app',
      SAZUZ_SERVER_HOST: '0.0.0.0',
      SAZUZ_SERVER_PORT: '9000',
      SAZUZ_WEB_PORT: '9001',
      SAZUZ_SERVER_URL: 'http://server:9000',
    });

    expect(config).toMatchObject({
      dataDir: resolve('custom-data'),
      databaseHost: 'postgres',
      databasePort: 5432,
      databaseName: 'sazuz_test',
      databaseUser: 'sazuz_app',
      serverHost: '0.0.0.0',
      serverPort: 9000,
      webPort: 9001,
      serverUrl: 'http://server:9000',
    });
    expect(readInfraConfig({ SAZUZ_SERVER_HOST: '::1', SAZUZ_SERVER_PORT: '9000' }).serverUrl).toBe(
      'http://[::1]:9000',
    );
    expect(readInfraConfig({ SAZUZ_SERVER_HOST: '::' }).serverUrl).toBe('http://127.0.0.1:7778');
  });

  it('ignores unrelated process variables, including provider credentials', () => {
    expect(
      readInfraConfig({
        OPENAI_API_KEY: 'canary-must-not-be-used',
        DATABASE_URL: 'not used',
        NODE_ENV: 'test',
      }),
    ).toEqual(readInfraConfig({}));
  });

  it.each([
    { SAZUZ_WEB_PORT: '0' },
    { SAZUZ_WEB_PORT: '65536' },
    { SAZUZ_DATABASE_PORT: '5432.5' },
    { SAZUZ_SERVER_PORT: '7778junk' },
    { SAZUZ_SERVER_PORT: '' },
    { SAZUZ_SERVER_HOST: 'http://localhost' },
    { SAZUZ_DATA_DIR: 'bad\u0000path' },
    { SAZUZ_DATABASE_NAME: '' },
    { SAZUZ_DATABASE_USER: 'user;drop' },
    { SAZUZ_DATABASE_URL: 'https://user:secret@example.com/database' },
    { SAZUZ_DATABASE_URL: 'postgres://user:secret@localhost/' },
    { SAZUZ_DATABASE_URL: 'postgres://user:%zz@localhost/database' },
    { SAZUZ_SERVER_URL: 'http://user:secret@localhost:7778' },
    { SAZUZ_SERVER_URL: 'http://localhost:7778/other-path' },
    { SAZUZ_SERVER_URL: 'http://localhost:7778?token=private' },
    { SAZUZ_SERVER_URL: 'not a URL' },
    { SAZUZ_SERVR_PORT: '7778' },
    { SAZUZ_API_KEY: 'provider keys belong in the vault' },
    { SAZUZ_BUDGET: '10' },
    { sazuz_server_port: '7778' },
  ])('rejects invalid or unsupported overrides with a typed error', (environment) => {
    expect(() => readInfraConfig(environment)).toThrow(ConfigError);
  });

  it('never exposes invalid values, unknown keys, or schema issues in errors', () => {
    const canary = 'error-canary-secret-5019';
    let caught: unknown;
    try {
      readInfraConfig({ SAZUZ_DATABASE_URL: `not-a-url-${canary}`, [`SAZUZ_${canary}`]: canary });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught).toMatchObject({
      code: 'INVALID_INFRA_CONFIG',
      message: 'Infrastructure configuration is invalid.',
    });
    expect(String(caught)).not.toContain(canary);
    expect(JSON.stringify(caught)).not.toContain(canary);
    expect(caught).not.toHaveProperty('cause');
    expect(caught).not.toHaveProperty('issues');
  });

  it('accepts PostgreSQL URI schemes and keeps credentials out of defaults', () => {
    const databaseUrl =
      'postgresql://app:external-credential@example.com:5432/sazuz?sslmode=require';
    expect(readInfraConfig({ SAZUZ_DATABASE_URL: databaseUrl }).databaseUrl).toBe(databaseUrl);
    expect(readInfraConfig({})).not.toHaveProperty('password');
    expect(readInfraConfig({})).not.toHaveProperty('databaseUrl');
  });
});
