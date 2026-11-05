import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { secretRedactor } from '@sazuz/vault';
import {
  bridgeAliasSchema,
  bridgeFolderSchema,
  bridgeManifestSchema,
  bridgePinSchema,
  BridgeError,
  type BridgeManifest,
} from '@sazuz/core/bridge';

export const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export function inside(root: string, path: string) {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}
const pathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => isAbsolute(value) && !value.includes('\0'));
const commandSchema = z.strictObject({
  alias: bridgeAliasSchema,
  executable: pathSchema,
  args: z
    .array(
      z
        .string()
        .max(1024)
        .refine((value) => !value.includes('\0')),
    )
    .max(32),
  folder: bridgeAliasSchema,
  // Extra scripts/modules loaded by an approved command can be pinned explicitly.
  files: z.array(pathSchema).max(16).default([]),
});
export const localInputSchema = z.strictObject({
  folders: z.array(bridgeFolderSchema.extend({ root: pathSchema })).max(16),
  commands: z.array(commandSchema).max(16),
  notifications: z.boolean().default(false),
  privateOnly: z.boolean().default(true),
});
const filePinSchema = z.strictObject({ path: pathSchema, sha256: bridgePinSchema });
export const localConfigSchema = localInputSchema.extend({
  folders: z
    .array(bridgeFolderSchema.extend({ root: pathSchema, dev: z.number(), ino: z.number() }))
    .max(16),
  commands: z.array(commandSchema.extend({ pins: z.array(filePinSchema).min(1).max(49) })).max(16),
});
export type LocalConfiguration = z.infer<typeof localConfigSchema>;
export const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
export const nonBlock = process.platform === 'win32' ? 0 : constants.O_NONBLOCK;

export async function fingerprint(path: string): Promise<z.infer<typeof filePinSchema>> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 268_435_456)
    throw new BridgeError('BRIDGE_DENIED');
  const actual = await realpath(path);
  if (resolve(path) !== actual) throw new BridgeError('BRIDGE_DENIED');
  const handle = await open(actual, constants.O_RDONLY | noFollow | nonBlock);
  try {
    const stat = await handle.stat();
    if (stat.ino !== before.ino || stat.dev !== before.dev || !stat.isFile())
      throw new BridgeError('BRIDGE_CHANGED');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(65_536);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - offset),
        offset,
      );
      if (!bytesRead) throw new BridgeError('BRIDGE_CHANGED');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new BridgeError('BRIDGE_CHANGED');
    return { path: actual, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}
export function manifest(config: LocalConfiguration): BridgeManifest {
  return bridgeManifestSchema.parse({
    folders: config.folders.map(({ alias, mode, delete: remove }) => ({
      alias,
      mode,
      delete: remove,
    })),
    commands: config.commands.map((command) => command.alias),
    notifications: config.notifications,
    privateOnly: config.privateOnly,
  });
}
export const localPin = (config: LocalConfiguration) =>
  digest(JSON.stringify(localConfigSchema.parse(config)));
export async function prepareLocalConfiguration(
  input: unknown,
  stateDir: string,
): Promise<LocalConfiguration> {
  const value = localInputSchema.parse(input),
    state = await realpath(stateDir);
  const folders: LocalConfiguration['folders'] = [];
  for (const folder of value.folders) {
    const root = await realpath(folder.root),
      stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || inside(root, state) || inside(state, root))
      throw new BridgeError('BRIDGE_DENIED');
    folders.push({ ...folder, root, dev: stat.dev, ino: stat.ino });
  }
  const commands: LocalConfiguration['commands'] = [];
  for (const command of value.commands) {
    const folder = folders.find((entry) => entry.alias === command.folder);
    if (!folder || folder.mode !== 'write') throw new BridgeError('BRIDGE_INVALID');
    const candidates = new Set([command.executable, ...command.files]);
    for (const arg of command.args.filter((arg) => !arg.startsWith('-'))) {
      const candidate = resolve(folder.root, arg);
      try {
        if ((await lstat(candidate)).isFile()) candidates.add(candidate);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    if ([...candidates].some((path) => inside(state, path))) throw new BridgeError('BRIDGE_DENIED');
    commands.push({ ...command, pins: await Promise.all([...candidates].map(fingerprint)) });
  }
  const config = localConfigSchema.parse({ ...value, folders, commands });
  if (JSON.stringify(config) !== JSON.stringify(secretRedactor.redact(config)))
    throw new BridgeError('BRIDGE_DENIED');
  manifest(config); // Uniqueness and public-manifest bounds are also required locally.
  return config;
}
