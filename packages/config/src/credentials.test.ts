import { randomBytes } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REDACTED, SecretRedactor, secretRedactor } from '@sazuz/vault';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfigError,
  databaseConnection,
  ensureDatabasePassword,
  readDatabasePassword,
  readInfraConfig,
} from './index.js';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sazuz-config-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('database infrastructure credential', () => {
  it('generates a random 256-bit credential once and reuses the exact bytes on restart', async () => {
    const directory = await temporaryDirectory();
    const first = await ensureDatabasePassword(directory);
    const filename = join(directory, 'secrets', 'db-password');
    const before = await readFile(filename, 'utf8');
    const beforeStats = await lstat(filename);

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first, 'base64url')).toHaveLength(32);
    expect(await ensureDatabasePassword(directory)).toBe(first);
    expect(await readDatabasePassword(directory)).toBe(first);
    expect(await readFile(filename, 'utf8')).toBe(before);
    expect((await lstat(filename)).mtimeMs).toBe(beforeStats.mtimeMs);
    expect(await readdir(join(directory, 'secrets'))).toEqual(['db-password']);
    expect(secretRedactor.redactText(first)).toBe(REDACTED);
  });

  it('makes simultaneous initializers and later readers agree without leaving temporary files', async () => {
    const directory = join(await temporaryDirectory(), 'nested', 'data');
    const results = await Promise.all(
      Array.from({ length: 24 }, () => ensureDatabasePassword(directory)),
    );

    expect(new Set(results).size).toBe(1);
    expect(await readDatabasePassword(directory)).toBe(results[0]);
    expect(await readdir(join(directory, 'secrets'))).toEqual(['db-password']);
    expect((await lstat(join(directory, 'secrets', 'db-password'))).nlink).toBe(1);
  });

  it('uses independent credentials for independent installations', async () => {
    const firstDir = await temporaryDirectory();
    const secondDir = await temporaryDirectory();
    expect(await ensureDatabasePassword(firstDir)).not.toBe(
      await ensureDatabasePassword(secondDir),
    );
  });

  it('never initializes a missing credential from a consumer connection', async () => {
    const directory = await temporaryDirectory();
    const config = readInfraConfig({ SAZUZ_DATA_DIR: directory });

    await expect(readDatabasePassword(directory)).rejects.toMatchObject({
      code: 'DATABASE_CREDENTIAL_MISSING',
    });
    await expect(databaseConnection(config, new SecretRedactor())).rejects.toMatchObject({
      code: 'DATABASE_CREDENTIAL_MISSING',
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    '',
    'short',
    ' '.repeat(43),
    'X'.repeat(43),
    `${'A'.repeat(43)}\r\n`,
    `${'A'.repeat(43)}\n\n`,
    'A'.repeat(500),
  ])('refuses to replace malformed existing credentials (fixture %s)', async (content) => {
    const directory = await temporaryDirectory();
    const secretsDir = join(directory, 'secrets');
    await mkdir(secretsDir, { mode: 0o700 });
    const filename = join(secretsDir, 'db-password');
    await writeFile(filename, content, { mode: 0o600 });

    await expect(ensureDatabasePassword(directory)).rejects.toMatchObject({
      code: 'DATABASE_CREDENTIAL_INVALID',
    });
    await expect(readDatabasePassword(directory)).rejects.toMatchObject({
      code: 'DATABASE_CREDENTIAL_INVALID',
    });
    expect(await readFile(filename, 'utf8')).toBe(content);
  });

  it('accepts an unchanged canonical credential with or without one line terminator', async () => {
    const directory = await temporaryDirectory();
    const secretsDir = join(directory, 'secrets');
    const value = randomBytes(32).toString('base64url');
    await mkdir(secretsDir, { mode: 0o700 });
    await writeFile(join(secretsDir, 'db-password'), value, { mode: 0o600 });

    expect(await ensureDatabasePassword(directory)).toBe(value);
    expect(await readFile(join(secretsDir, 'db-password'), 'utf8')).toBe(value);
  });

  it('rejects a directory in place of a password file', async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, 'secrets'), { mode: 0o700 });
    await mkdir(join(directory, 'secrets', 'db-password'), { mode: 0o700 });

    await expect(ensureDatabasePassword(directory)).rejects.toMatchObject({
      code: 'DATABASE_CREDENTIAL_UNSAFE',
    });
  });

  it('rejects a secrets directory redirected through a symlink or Windows junction', async () => {
    const directory = await temporaryDirectory();
    const target = await temporaryDirectory();
    await symlink(
      target,
      join(directory, 'secrets'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(ensureDatabasePassword(directory)).rejects.toMatchObject({
      code: 'DATABASE_CREDENTIAL_UNSAFE',
    });
    expect(await readdir(target)).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')(
    'rejects unsafe Unix modes and file symlinks',
    async () => {
      const directory = await temporaryDirectory();
      const value = await ensureDatabasePassword(directory);
      const filename = join(directory, 'secrets', 'db-password');
      expect((await lstat(filename)).mode & 0o777).toBe(0o600);
      expect((await lstat(join(directory, 'secrets'))).mode & 0o777).toBe(0o700);

      await chmod(filename, 0o644);
      await expect(readDatabasePassword(directory)).rejects.toMatchObject({
        code: 'DATABASE_CREDENTIAL_UNSAFE',
      });
      await chmod(filename, 0o600);
      await chmod(join(directory, 'secrets'), 0o755);
      await expect(readDatabasePassword(directory)).rejects.toMatchObject({
        code: 'DATABASE_CREDENTIAL_UNSAFE',
      });
      await chmod(join(directory, 'secrets'), 0o700);
      const original = join(directory, 'secrets', 'original');
      await link(filename, original);
      await rm(filename);
      await symlink(original, filename, 'file');
      await expect(readDatabasePassword(directory)).rejects.toMatchObject({
        code: 'DATABASE_CREDENTIAL_UNSAFE',
      });
      expect(await readFile(original, 'utf8')).toBe(`${value}\n`);
    },
  );

  it('returns fixed errors without leaking file contents or credential-bearing paths', async () => {
    const directory = join(await temporaryDirectory(), 'path-canary-7294');
    await mkdir(join(directory, 'secrets'), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'secrets', 'db-password'), 'content-canary-8521', {
      mode: 0o600,
    });
    let caught: unknown;
    try {
      await ensureDatabasePassword(directory);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect(String(caught)).not.toContain('canary');
    expect(JSON.stringify(caught)).not.toContain('canary');
    expect(caught).not.toHaveProperty('cause');
    await expect(ensureDatabasePassword('bad\u0000path')).rejects.toMatchObject({
      code: 'INVALID_INFRA_CONFIG',
    });
  });
});

describe('databaseConnection', () => {
  it('registers local credentials before passing them to the database driver', async () => {
    const directory = await temporaryDirectory();
    const password = await ensureDatabasePassword(directory);
    const redactor = new SecretRedactor();
    const connection = await databaseConnection(
      readInfraConfig({ SAZUZ_DATA_DIR: directory }),
      redactor,
    );

    expect(connection).toEqual({
      host: '127.0.0.1',
      port: 54329,
      user: 'sazuz',
      database: 'sazuz',
      password,
    });
    expect(redactor.redactText(`driver failed: ${password}`)).toBe(`driver failed: ${REDACTED}`);
  });

  it('registers external URLs, decoded passwords, and credential query values before use', async () => {
    const directory = await temporaryDirectory();
    const password = 'external-canary /:@+?& 8192';
    const queryPassword = 'query-canary-8191';
    const url = `postgresql://app:${encodeURIComponent(password)}@example.com:5432/sazuz?password=${queryPassword}&sslmode=require`;
    const redactor = new SecretRedactor();
    const config = readInfraConfig({ SAZUZ_DATA_DIR: directory, SAZUZ_DATABASE_URL: url });

    expect(await databaseConnection(config, redactor)).toEqual({ connectionString: url });
    expect(redactor.redactText(url)).toBe(REDACTED);
    expect(redactor.redactText(password)).toBe(REDACTED);
    expect(redactor.redactText(queryPassword)).toBe(REDACTED);
    expect(await readdir(directory)).toEqual([]);
  });

  it('validates consumer inputs again and safely rejects mutated configuration', async () => {
    const config = readInfraConfig({});
    config.databaseUrl = 'bad-url-with-secret-3518';
    await expect(databaseConnection(config, new SecretRedactor())).rejects.toMatchObject({
      code: 'INVALID_INFRA_CONFIG',
    });
  });
});
