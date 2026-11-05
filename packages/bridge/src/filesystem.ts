import { constants, type Stats } from 'node:fs';
import { link, lstat, open, opendir, realpath, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BridgeError, bridgeInputs, bridgePathSchema, type BridgeTool } from '@sazuz/core/bridge';
import { inside, noFollow, nonBlock, type LocalConfiguration } from './local-config.js';

function absent(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
export function checkSignal(signal: AbortSignal) {
  if (signal.aborted) throw new BridgeError('BRIDGE_DENIED');
}
async function syncParent(path: string) {
  if (process.platform === 'win32') return;
  const directory = await open(dirname(path), constants.O_RDONLY | noFollow);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function scopedPath(
  config: LocalConfiguration,
  stateDir: string,
  alias: string,
  input: string,
  missing = false,
) {
  const folder = config.folders.find((item) => item.alias === alias),
    path = bridgePathSchema.parse(input);
  if (!folder || inside(folder.root, stateDir) || inside(stateDir, folder.root))
    throw new BridgeError('BRIDGE_DENIED');
  const rootStat = await lstat(folder.root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.ino !== folder.ino ||
    rootStat.dev !== folder.dev ||
    (await realpath(folder.root)) !== folder.root
  )
    throw new BridgeError('BRIDGE_CHANGED');
  let target = folder.root,
    stat: Stats | null = rootStat;
  const parts = path ? path.split('/') : [];
  for (let index = 0; index < parts.length; index++) {
    target = join(target, parts[index]!);
    if (!inside(folder.root, target) || inside(stateDir, target))
      throw new BridgeError('BRIDGE_DENIED');
    try {
      stat = await lstat(target);
    } catch (error) {
      if (missing && index === parts.length - 1 && absent(error)) {
        stat = null;
        break;
      }
      throw error;
    }
    if (
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && !stat.isFile()) ||
      (stat.isFile() && stat.nlink !== 1) ||
      (index < parts.length - 1 && !stat.isDirectory())
    )
      throw new BridgeError('BRIDGE_DENIED');
    if ((await realpath(target)) !== target) throw new BridgeError('BRIDGE_DENIED');
  }
  return { folder, target, stat };
}
export async function executeFile(
  config: LocalConfiguration,
  stateDir: string,
  tool: BridgeTool,
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  if (!tool.startsWith('local.fs.')) throw new BridgeError('BRIDGE_INVALID');
  const args = bridgeInputs[tool].parse(input);
  if (!('folder' in args) || !('path' in args)) throw new BridgeError('BRIDGE_INVALID');
  const writing = !['local.fs.list', 'local.fs.read'].includes(tool);
  const scoped = await scopedPath(
    config,
    stateDir,
    args.folder,
    args.path,
    tool === 'local.fs.write',
  );
  if (writing && scoped.folder.mode !== 'write') throw new BridgeError('BRIDGE_DENIED');
  checkSignal(signal);
  if (tool === 'local.fs.list') {
    if (!scoped.stat?.isDirectory()) throw new BridgeError('BRIDGE_DENIED');
    const entries: { name: string; type: string }[] = [];
    let truncated = false;
    const directory = await opendir(scoped.target);
    for await (const item of directory) {
      checkSignal(signal);
      if (entries.length >= 100) {
        truncated = true;
        break;
      }
      if (
        !bridgePathSchema.safeParse(item.name).success ||
        item.isSymbolicLink() ||
        (!item.isFile() && !item.isDirectory())
      )
        continue;
      entries.push({ name: item.name, type: item.isDirectory() ? 'directory' : 'file' });
    }
    await scopedPath(config, stateDir, args.folder, args.path);
    return { entries, truncated };
  }
  if (scoped.stat && !scoped.stat.isFile()) throw new BridgeError('BRIDGE_DENIED');
  if (tool === 'local.fs.read') {
    const read = bridgeInputs['local.fs.read'].parse(args);
    const handle = await open(scoped.target, constants.O_RDONLY | noFollow | nonBlock);
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.ino !== scoped.stat?.ino ||
        stat.dev !== scoped.stat.dev
      )
        throw new BridgeError('BRIDGE_CHANGED');
      await scopedPath(config, stateDir, args.folder, args.path);
      checkSignal(signal);
      const buffer = Buffer.alloc(4096),
        { bytesRead } = await handle.read(buffer, 0, buffer.length, read.offset);
      const content = buffer.subarray(0, bytesRead).toString('utf8');
      if (content.includes('\0') || content.includes('\uFFFD'))
        throw new BridgeError('BRIDGE_INVALID');
      return {
        content,
        nextOffset: read.offset + bytesRead,
        truncated: read.offset + bytesRead < stat.size,
      };
    } finally {
      await handle.close();
    }
  }
  if (tool === 'local.fs.write') {
    const write = bridgeInputs['local.fs.write'].parse(args),
      data = Buffer.from(write.content);
    if (data.length > 4096) throw new BridgeError('BRIDGE_INVALID');
    const handle = await open(
      scoped.target,
      constants.O_WRONLY |
        noFollow |
        nonBlock |
        (scoped.stat ? 0 : constants.O_CREAT | constants.O_EXCL),
      0o600,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (scoped.stat && (stat.ino !== scoped.stat.ino || stat.dev !== scoped.stat.dev))
      )
        throw new BridgeError('BRIDGE_CHANGED');
      await scopedPath(config, stateDir, args.folder, args.path);
      checkSignal(signal);
      await handle.truncate(0);
      await handle.writeFile(data);
      await handle.sync();
      if (!scoped.stat) await syncParent(scoped.target);
      return { written: data.length };
    } finally {
      await handle.close();
      data.fill(0);
    }
  }
  if (!scoped.stat?.isFile()) throw new BridgeError('BRIDGE_DENIED');
  if (tool === 'local.fs.delete') {
    if (!scoped.folder.delete) throw new BridgeError('BRIDGE_DENIED');
    await scopedPath(config, stateDir, args.folder, args.path);
    checkSignal(signal);
    await unlink(scoped.target);
    await syncParent(scoped.target);
    return { deleted: true };
  }
  const move = bridgeInputs['local.fs.move'].parse(args);
  const destination = await scopedPath(config, stateDir, args.folder, move.destination, true);
  if (destination.stat || dirname(destination.target) === destination.target)
    throw new BridgeError('BRIDGE_DENIED');
  await scopedPath(config, stateDir, args.folder, args.path);
  checkSignal(signal);
  // link refuses an occupied destination. A crash between link/unlink stays uncertain in the receipt.
  await link(scoped.target, destination.target);
  await syncParent(destination.target);
  await unlink(scoped.target);
  await syncParent(scoped.target);
  return { moved: true };
}
