import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readInfraConfig } from '@sazuz/config';
import { SazuzError } from '@sazuz/core';
import { developmentDatabaseEnvironment } from './dev-infrastructure.js';

describe('development database provisioning', () => {
  it('shares the default credential path and loopback endpoint with Compose', () => {
    const environment = developmentDatabaseEnvironment(readInfraConfig({}), { PATH: 'tools' });
    expect(environment).toEqual({
      PATH: 'tools',
      SAZUZ_DATA_DIR: resolve('data'),
      SAZUZ_DATABASE_HOST: '127.0.0.1',
      SAZUZ_DATABASE_PORT: '54329',
      SAZUZ_DATABASE_NAME: 'sazuz',
      SAZUZ_DATABASE_USER: 'sazuz',
    });
  });

  it('propagates validated overrides instead of binding a different credential path or port', () => {
    const config = readInfraConfig({
      SAZUZ_DATA_DIR: './custom data',
      SAZUZ_DATABASE_HOST: 'localhost',
      SAZUZ_DATABASE_PORT: '54330',
      SAZUZ_DATABASE_NAME: 'custom_database',
      SAZUZ_DATABASE_USER: 'custom_user',
    });
    const environment = developmentDatabaseEnvironment(config, { SAZUZ_DATA_DIR: './old-path' });
    expect(environment).toMatchObject({
      SAZUZ_DATA_DIR: resolve('custom data'),
      SAZUZ_DATABASE_HOST: '127.0.0.1',
      SAZUZ_DATABASE_PORT: '54330',
      SAZUZ_DATABASE_NAME: 'custom_database',
      SAZUZ_DATABASE_USER: 'custom_user',
    });
  });

  it('uses the IPv6 loopback binding when explicitly configured', () => {
    const config = readInfraConfig({ SAZUZ_DATABASE_HOST: '::1' });
    expect(developmentDatabaseEnvironment(config, {}).SAZUZ_DATABASE_HOST).toBe('::1');
  });

  it.each([
    { SAZUZ_DATABASE_HOST: 'database.example.com' },
    { SAZUZ_DATABASE_URL: 'postgresql://user:canary-password@127.0.0.1/custom' },
  ])('does not provision a local replacement for an unreachable external database', (overrides) => {
    const config = readInfraConfig(overrides);
    expect(() => developmentDatabaseEnvironment(config, {})).toThrow(SazuzError);
    expect(() => developmentDatabaseEnvironment(config, {})).toThrow(
      'Configured external database is unavailable. Start it before running pnpm dev.',
    );
  });
});
