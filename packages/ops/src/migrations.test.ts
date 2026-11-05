import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  installedMigrations,
  requireMigrationHistory,
  requireRestoreMigrations,
} from './migrations.js';

describe('authenticated snapshot migration compatibility', () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sazuz-migration-identity-'));
    await mkdir(join(directory, 'meta'));
    await writeFile(
      join(directory, 'meta/_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [
          { idx: 0, version: '7', when: 1000, tag: '0000_initial', breakpoints: true },
          { idx: 1, version: '7', when: 2000, tag: '0001_second', breakpoints: true },
        ],
      }),
    );
    await writeFile(join(directory, '0000_initial.sql'), 'CREATE TABLE proof(id integer);\n');
    await writeFile(join(directory, '0001_second.sql'), 'ALTER TABLE proof ADD content text;\n');
  });
  afterAll(async () => {
    if (
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
      directory.includes('sazuz-migration-identity-')
    )
      await rm(directory, { recursive: true, force: true });
  });
  it('requires exact source history, including order, timestamps and SQL hashes', async () => {
    const installed = await installedMigrations(directory);
    expect(installed.identity.count).toBe(2);
    expect(() => requireMigrationHistory(installed, installed.history)).not.toThrow();
    for (const history of [
      installed.history.slice(1),
      [...installed.history].reverse(),
      [...installed.history, installed.history[0]],
      [{ ...installed.history[0], when: '1001' }, installed.history[1]],
      [{ ...installed.history[0], hash: 'a'.repeat(64) }, installed.history[1]],
    ])
      expect(() => requireMigrationHistory(installed, history)).toThrowError(/migration/);
  });
  it('matches installed files without consulting the damaged candidate database', async () => {
    const original = (await installedMigrations(directory)).identity;
    await expect(requireRestoreMigrations(original, directory)).resolves.toBeUndefined();
    await writeFile(join(directory, '0001_second.sql'), 'ALTER TABLE proof ADD changed text;\n');
    const changed = (await installedMigrations(directory)).identity;
    expect(changed.count).toBe(original.count);
    expect(changed.sha256).not.toBe(original.sha256);
    await expect(requireRestoreMigrations(original, directory)).rejects.toMatchObject({
      code: 'OPS_RESTORE_VERSION',
    });
  });
  it('rejects unsafe or missing installed migration files with a typed error', async () => {
    await writeFile(
      join(directory, 'meta/_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [{ idx: 0, version: '7', when: 1000, tag: '../escape', breakpoints: true }],
      }),
    );
    await expect(installedMigrations(directory)).rejects.toMatchObject({ code: 'OPS_MIGRATIONS' });
    await expect(installedMigrations(join(directory, 'absent'))).rejects.toMatchObject({
      code: 'OPS_MIGRATIONS',
    });
  });
});
