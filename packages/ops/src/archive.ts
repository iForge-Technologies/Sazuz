import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { MAX_BACKUP_BYTES, OperationsError } from '@sazuz/core/operations';
import { readPrivateFiles, preparePrivateSecretDirectory } from '@sazuz/config/private-files';
import { settingsDocumentSchema, type SettingsDocument } from '@sazuz/config/settings';
import { migrationIdentitySchema, type MigrationIdentity } from './migrations.js';

const keys = ['session.key', 'machine.key', 'operator.key', 'vapid.key'] as const;
const portable = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.startsWith('/') &&
      value
        .split('/')
        .every(
          (part) =>
            part.length > 0 &&
            part !== '.' &&
            part !== '..' &&
            !/[<>:"|?*]/.test(part) &&
            ![...part].some(
              (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
            ) &&
            !/[ .]$/.test(part) &&
            !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part),
        ),
  );
const manifestSchema = z.strictObject({
  version: z.literal(2),
  migrations: migrationIdentitySchema,
  settings: settingsDocumentSchema,
  files: z
    .array(
      z.strictObject({
        path: portable,
        type: z.enum(['file', 'directory']),
        bytes: z.number().int().nonnegative().max(MAX_BACKUP_BYTES),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(5)
    .max(10005),
});
export type SnapshotFile = { path: string; data: Buffer; type: 'file' | 'directory' };
export type Snapshot = {
  files: SnapshotFile[];
  settings: SettingsDocument;
  migrations: MigrationIdentity;
};
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const absent = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

function validatePaths(files: { path: string; type: 'file' | 'directory' }[]) {
  const seen = new Map<string, string>();
  for (const file of files) {
    const path = file.path.toLowerCase();
    if (!portable.safeParse(file.path).success || seen.has(path))
      throw new OperationsError('OPS_UNSAFE_PATH');
    if (
      file.path !== 'database.pgdump' &&
      !keys.some((key) => file.path === `secrets/${key}`) &&
      file.path !== 'workspace' &&
      !file.path.startsWith('workspace/')
    )
      throw new OperationsError('OPS_UNSAFE_PATH');
    if (
      (file.type === 'directory' && !file.path.startsWith('workspace')) ||
      (file.path === 'workspace' && file.type !== 'directory')
    )
      throw new OperationsError('OPS_UNSAFE_PATH');
    seen.set(path, file.type);
  }
  // Check the complete set, including children that precede their parent in an input manifest.
  for (const file of files) {
    const parts = file.path.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++)
      if (seen.get(parts.slice(0, i).join('/')) === 'file')
        throw new OperationsError('OPS_UNSAFE_PATH');
  }
  if (
    seen.get('database.pgdump') !== 'file' ||
    keys.some((key) => seen.get(`secrets/${key}`) !== 'file')
  )
    throw new OperationsError('OPS_INVALID');
}
export function packSnapshot(snapshot: Snapshot): Buffer {
  const files = [...snapshot.files].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  validatePaths(files);
  if (files.some((file) => file.type === 'directory' && file.data.length))
    throw new OperationsError('OPS_INVALID');
  const manifest = manifestSchema.parse({
    version: 2,
    migrations: snapshot.migrations,
    settings: snapshot.settings,
    files: files.map((file) => ({
      path: file.path,
      type: file.type,
      bytes: file.data.length,
      sha256: digest(file.data),
    })),
  });
  const json = Buffer.from(JSON.stringify(manifest));
  if (
    json.length > 2 * 1024 * 1024 ||
    files.reduce((sum, file) => sum + file.data.length, 4 + json.length) > MAX_BACKUP_BYTES
  )
    throw new OperationsError('OPS_LIMIT');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([length, json, ...files.map((file) => file.data)]);
}
export function unpackSnapshot(payload: Uint8Array): Snapshot {
  if (payload.length > MAX_BACKUP_BYTES || payload.length < 4)
    throw new OperationsError('OPS_LIMIT');
  const data = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const size = data.readUInt32BE(0);
  if (size > 2 * 1024 * 1024 || size + 4 > data.length) throw new OperationsError('OPS_INVALID');
  let manifest: z.infer<typeof manifestSchema>;
  try {
    const raw: unknown = JSON.parse(data.subarray(4, 4 + size).toString('utf8'));
    if (
      !z.object({ version: z.literal(2), migrations: migrationIdentitySchema }).safeParse(raw)
        .success
    )
      throw new OperationsError('OPS_RESTORE_VERSION');
    manifest = manifestSchema.parse(raw);
  } catch (error) {
    if (error instanceof OperationsError) throw error;
    throw new OperationsError('OPS_INVALID');
  }
  validatePaths(manifest.files);
  let offset = 4 + size;
  const files = manifest.files.map((file) => {
    const value = data.subarray(offset, offset + file.bytes);
    offset += file.bytes;
    if (
      value.length !== file.bytes ||
      digest(value) !== file.sha256 ||
      (file.type === 'directory' && value.length)
    )
      throw new OperationsError('OPS_INVALID');
    return { path: file.path, type: file.type, data: value };
  });
  if (
    offset !== data.length ||
    !files
      .find((file) => file.path === 'database.pgdump')!
      .data.subarray(0, 5)
      .equals(Buffer.from('PGDMP'))
  )
    throw new OperationsError('OPS_INVALID');
  for (const key of keys) {
    const value = files
      .find((file) => file.path === `secrets/${key}`)!
      .data.toString('utf8')
      .trim();
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(value) ||
      Buffer.from(value, 'base64url').toString('base64url') !== value
    )
      throw new OperationsError('OPS_INVALID');
  }
  return { files, settings: manifest.settings, migrations: manifest.migrations };
}
export async function snapshotFiles(dataDir: string): Promise<SnapshotFile[]> {
  const secretFiles = await readPrivateFiles(
    dataDir,
    keys.map((name) => ({ name, maxBytes: 44 })),
  );
  const result: SnapshotFile[] = [...secretFiles].map(([name, data]) => ({
    path: `secrets/${name}`,
    data,
    type: 'file',
  }));
  const candidate = join(resolve(dataDir), 'workspace');
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  if ((await lstat(candidate)).isSymbolicLink()) throw new OperationsError('OPS_UNSAFE_PATH');
  const root = await realpath(candidate);
  let total = 176;
  const walk = async (path: string): Promise<void> => {
    const stats = await lstat(path),
      canonical = await realpath(path);
    if (stats.isSymbolicLink() || (canonical !== root && !canonical.startsWith(root + sep)))
      throw new OperationsError('OPS_UNSAFE_PATH');
    const name =
      path === root ? 'workspace' : 'workspace/' + relative(root, path).split(sep).join('/');
    if (!portable.safeParse(name).success || result.length >= 10004)
      throw new OperationsError('OPS_UNSAFE_PATH');
    if (stats.isDirectory()) {
      result.push({ path: name, type: 'directory', data: Buffer.alloc(0) });
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry));
      return;
    }
    if (!stats.isFile() || stats.nlink !== 1) throw new OperationsError('OPS_UNSAFE_PATH');
    total += stats.size;
    if (total > MAX_BACKUP_BYTES) throw new OperationsError('OPS_LIMIT');
    const fd = await open(path, constants.O_RDONLY | noFollow);
    try {
      const current = await fd.stat();
      if (current.dev !== stats.dev || current.ino !== stats.ino || current.nlink !== 1)
        throw new OperationsError('OPS_UNSAFE_PATH');
      // Bounded reads even if another process grows a file after lstat.
      const data = Buffer.alloc(stats.size);
      const { bytesRead } = await fd.read(data, 0, data.length, 0);
      const after = await fd.stat();
      if (
        bytesRead !== stats.size ||
        after.size !== stats.size ||
        after.mtimeMs !== stats.mtimeMs
      ) {
        data.fill(0);
        throw new OperationsError('OPS_BUSY');
      }
      result.push({ path: name, type: 'file', data });
    } finally {
      await fd.close();
    }
  };
  try {
    await walk(root);
    return result;
  } catch (error) {
    for (const file of result) file.data.fill(0);
    throw error;
  }
}

/** Fresh installation or exclusive maintenance only. The whole authenticated archive is validated first. */
export async function applySnapshotFiles(dataDir: string, files: SnapshotFile[]): Promise<void> {
  validatePaths(files);
  await preparePrivateSecretDirectory(dataDir);
  const root = await realpath(dataDir),
    workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const inspect = async (path: string): Promise<void> => {
    const stat = await lstat(path),
      canonical = await realpath(path);
    if (
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) ||
      (canonical !== root && !canonical.startsWith(root + sep))
    )
      throw new OperationsError('OPS_UNSAFE_PATH');
    if (stat.isDirectory()) for (const name of await readdir(path)) await inspect(join(path, name));
  };
  await inspect(workspace);
  for (const key of keys) {
    try {
      await inspect(join(root, 'secrets', key));
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }
  const expected = new Map(files.map((file) => [file.path, file.type]));
  const clean = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const target = join(directory, name),
        stat = await lstat(target);
      const relativeName = 'workspace/' + relative(workspace, target).split(sep).join('/');
      if (stat.isDirectory()) {
        await clean(target);
        if (
          expected.get(relativeName) !== 'directory' &&
          ![...expected.keys()].some((key) => key.startsWith(relativeName + '/'))
        )
          await rmdir(target);
      } else if (expected.get(relativeName) !== 'file') await unlink(target);
    }
  };
  await clean(workspace);
  for (const file of [...files].sort((a, b) => a.path.length - b.path.length)) {
    if (file.path === 'database.pgdump') continue;
    const target = join(root, ...file.path.split('/'));
    let parent = root;
    for (const part of file.path.split('/').slice(0, file.type === 'directory' ? undefined : -1)) {
      parent = join(parent, part);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const stats = await lstat(parent);
      if (!stats.isDirectory() || stats.isSymbolicLink())
        throw new OperationsError('OPS_UNSAFE_PATH');
    }
    if (file.type === 'directory') continue;
    const temporary = join(parent, `.restore-${randomUUID()}`);
    const fd = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    try {
      await fd.writeFile(file.data);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(temporary, target);
  }
}
