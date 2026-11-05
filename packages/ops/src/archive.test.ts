import { mkdtemp, mkdir, readFile, writeFile, rm, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ensurePlumbing } from '@sazuz/config';
import { freshSettings } from '@sazuz/config/settings';
import {
  applySnapshotFiles,
  packSnapshot,
  snapshotFiles,
  unpackSnapshot,
  type SnapshotFile,
} from './archive.js';

const files = (): SnapshotFile[] => [
  { path: 'database.pgdump', type: 'file', data: Buffer.from('PGDMPfixture') },
  ...['session.key', 'machine.key', 'operator.key', 'vapid.key'].map((name) => ({
    path: `secrets/${name}`,
    type: 'file' as const,
    data: Buffer.from(randomBytes(32).toString('base64url')),
  })),
  { path: 'workspace/empty', type: 'directory', data: Buffer.alloc(0) },
  { path: 'workspace/notes.txt', type: 'file', data: Buffer.from('saved notes') },
];
const migrations = { count: 30, sha256: 'a'.repeat(64) };
describe('bounded portable snapshots', () => {
  it('authenticates per-file contents, directory inventory and settings structure', () => {
    const packed = packSnapshot({ files: files(), settings: freshSettings(), migrations }),
      snapshot = unpackSnapshot(packed);
    expect(snapshot.files.find((file) => file.path === 'workspace/empty')?.type).toBe('directory');
    expect(
      snapshot.files.find((file) => file.path === 'workspace/notes.txt')?.data.toString(),
    ).toBe('saved notes');
    packed[packed.length - 1] = packed[packed.length - 1]! ^ 1;
    expect(() => unpackSnapshot(packed)).toThrow();
    expect(() => unpackSnapshot(Buffer.alloc(3))).toThrow();
    const excess = Buffer.alloc(4);
    excess.writeUInt32BE(3000000);
    expect(() => unpackSnapshot(excess)).toThrow();
  });
  it.each([
    'workspace/../escape',
    'workspace/C:drive',
    'workspace/a\\b',
    '/workspace/a',
    'workspace/con.txt',
    'workspace/a.',
    'workspace//a',
    'secrets/db-password',
  ])('rejects unsafe path %s', (path) => {
    expect(() =>
      packSnapshot({
        files: [...files(), { path, type: 'file', data: Buffer.alloc(0) }],
        settings: freshSettings(),
        migrations,
      }),
    ).toThrow();
  });
  it('rejects duplicate case variants and parent/child collisions in both orders', () => {
    const directory: SnapshotFile = {
      path: 'workspace/parent',
      type: 'file',
      data: Buffer.alloc(0),
    };
    const child: SnapshotFile = { ...directory, path: 'workspace/parent/child' };
    for (const additions of [
      [directory, child],
      [child, directory],
      [{ ...child, path: 'workspace/NOTES.TXT' }],
    ])
      expect(() =>
        packSnapshot({ files: [...files(), ...additions], settings: freshSettings(), migrations }),
      ).toThrow();
  });
  it('requires an authenticated migration identity before accepting a pre-release snapshot', () => {
    const payload = packSnapshot({ files: files(), settings: freshSettings(), migrations });
    const size = payload.readUInt32BE(0);
    const raw = JSON.parse(payload.subarray(4, 4 + size).toString()) as Record<string, unknown>;
    delete raw.migrations;
    raw.version = 1;
    const json = Buffer.from(JSON.stringify(raw));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    const unmarked = Buffer.concat([length, json, payload.subarray(4 + size)]);
    expect(() => unpackSnapshot(unmarked)).toThrowError(/matching release/);
  });
  it('restores exact files and empty directories, preserves the target database password and rejects hardlinks before changing content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sazuz-archive-test-'));
    try {
      await ensurePlumbing(root);
      await mkdir(join(root, 'workspace'), { mode: 0o700 });
      await writeFile(join(root, 'secrets/db-password'), 'target-generated-db-password', {
        mode: 0o600,
      });
      await writeFile(join(root, 'workspace/obsolete.txt'), 'obsolete');
      const input = files();
      await applySnapshotFiles(root, input);
      expect(await readFile(join(root, 'workspace/notes.txt'), 'utf8')).toBe('saved notes');
      await expect(readFile(join(root, 'workspace/obsolete.txt'))).rejects.toThrow();
      expect(await readFile(join(root, 'secrets/db-password'), 'utf8')).toBe(
        'target-generated-db-password',
      );
      const captured = await snapshotFiles(root);
      expect(
        captured.some((file) => file.path === 'workspace/empty' && file.type === 'directory'),
      ).toBe(true);
      const external = join(root, 'outside.txt');
      await writeFile(external, 'must survive');
      await link(external, join(root, 'workspace/hardlink.txt'));
      await expect(applySnapshotFiles(root, input)).rejects.toMatchObject({
        code: 'OPS_UNSAFE_PATH',
      });
      await expect(snapshotFiles(root)).rejects.toMatchObject({ code: 'OPS_UNSAFE_PATH' });
      expect(await readFile(external, 'utf8')).toBe('must survive');
    } finally {
      if (resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('sazuz-archive-test-'))
        await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
