import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { checkAbort, ToolError } from './errors.js';
import { defineTool, type ToolContext } from './registry.js';

const maxWriteBytes = 262_144;
const filePath = z.string().min(1).max(1024);
const writeArgs = z.strictObject({ path: filePath, content: z.string().max(maxWriteBytes) });
const writeResult = z.strictObject({
  path: filePath,
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

function fileCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function segments(relativePath: string): string[] {
  if (
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    /[\\<>:"|?*]/.test(relativePath) ||
    [...relativePath].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new ToolError('UNSAFE_PATH');
  const parts = relativePath.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
    )
  ) {
    throw new ToolError('UNSAFE_PATH');
  }
  return parts;
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new ToolError('UNSAFE_PATH');
}

async function inspect(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if (fileCode(error) === 'ENOENT') return undefined;
    throw new ToolError('UNSAFE_PATH');
  }
}

interface ConfinedPath {
  root: string;
  target: string;
  parent: string;
  parentStat: Stats;
  parts: string[];
}

async function confinedPath(
  context: ToolContext,
  relativePath: string,
  createParents: boolean,
): Promise<ConfinedPath> {
  checkAbort(context.signal);
  const parts = segments(relativePath);
  if (!path.isAbsolute(context.workspaceDir)) throw new ToolError('UNSAFE_PATH');
  const rootStat = await inspect(context.workspaceDir);
  if (rootStat === undefined || !rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new ToolError('UNSAFE_PATH');
  const root = await realpath(context.workspaceDir);
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    checkAbort(context.signal);
    const next = path.join(parent, part);
    let stat = await inspect(next);
    if (stat === undefined && createParents) {
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (error) {
        if (fileCode(error) !== 'EEXIST') throw new ToolError('UNSAFE_PATH');
      }
      stat = await inspect(next);
    }
    if (stat === undefined) throw new ToolError('FILE_NOT_FOUND');
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ToolError('UNSAFE_PATH');
    const canonical = await realpath(next);
    assertInside(root, canonical);
    parent = canonical;
  }
  const parentStat = await lstat(parent);
  const target = path.join(parent, parts.at(-1)!);
  assertInside(root, target);
  const targetStat = await inspect(target);
  if (
    targetStat !== undefined &&
    (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1)
  )
    throw new ToolError('UNSAFE_PATH');
  return { root, target, parent, parentStat, parts };
}

async function verifyParents(context: ToolContext, confined: ConfinedPath): Promise<void> {
  const verified = await confinedPath(context, confined.parts.join('/'), false);
  if (
    verified.root !== confined.root ||
    verified.parent !== confined.parent ||
    verified.parentStat.dev !== confined.parentStat.dev ||
    verified.parentStat.ino !== confined.parentStat.ino
  )
    throw new ToolError('UNSAFE_PATH');
}

async function openConfined(context: ToolContext, confined: ConfinedPath): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(
      confined.target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (fileCode(error) === 'ENOENT') throw new ToolError('FILE_NOT_FOUND');
    throw new ToolError('UNSAFE_PATH');
  }
  try {
    const stat = await handle.stat();
    const current = await lstat(confined.target);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      current.isSymbolicLink() ||
      stat.dev !== current.dev ||
      stat.ino !== current.ino
    )
      throw new ToolError('UNSAFE_PATH');
    assertInside(confined.root, await realpath(confined.target));
    await verifyParents(context, confined);
    return handle;
  } catch (error) {
    await handle.close();
    if (error instanceof ToolError) throw error;
    throw new ToolError('UNSAFE_PATH');
  }
}

function receipt(args: z.infer<typeof writeArgs>): z.infer<typeof writeResult> {
  return {
    path: args.path,
    bytes: Buffer.byteLength(args.content, 'utf8'),
    sha256: createHash('sha256').update(args.content).digest('hex'),
  };
}

async function readBounded(
  handle: FileHandle,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const buffer = Buffer.alloc(limit);
  let size = 0;
  while (size < buffer.length) {
    checkAbort(signal);
    const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
    if (bytesRead === 0) break;
    size += bytesRead;
  }
  return buffer.subarray(0, size);
}

async function removeTemporary(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if (fileCode(error) !== 'ENOENT') throw new ToolError('TOOL_FAILED');
  }
}

export const filesRead = defineTool({
  name: 'files.read',
  description:
    'Read bounded UTF-8 text from a regular file inside this project workspace. Paths are relative to the workspace and symbolic links are not followed.',
  input: z.strictObject({
    path: filePath,
    maxBytes: z.number().int().min(1).max(65_536).default(32_768),
  }),
  output: z.strictObject({
    path: filePath,
    content: z.string(),
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  effect: 'read',
  scope: 'internal',
  // Project files can contain documents imported from outside Sazuz.
  untrusted: true,
  async run(context, args) {
    const confined = await confinedPath(context, args.path, false);
    const handle = await openConfined(context, confined);
    try {
      checkAbort(context.signal);
      const buffer = await readBounded(handle, args.maxBytes + 1, context.signal);
      const bytesRead = buffer.length;
      return {
        path: args.path,
        content: buffer.subarray(0, Math.min(args.maxBytes, bytesRead)).toString('utf8'),
        bytes: Math.min(args.maxBytes, bytesRead),
        truncated: bytesRead > args.maxBytes,
      };
    } finally {
      await handle.close();
    }
  },
});

export const filesWrite = defineTool({
  name: 'files.write',
  description:
    'Create or replace a UTF-8 text file inside this project workspace. Repeating the same write replaces the same content; this tool never appends. Paths are relative; symbolic links are not followed.',
  input: writeArgs,
  output: writeResult,
  effect: 'write',
  scope: 'internal',
  async run(context, args) {
    const expected = receipt(args);
    if (expected.bytes > maxWriteBytes) throw new ToolError('FILE_TOO_LARGE');
    const confined = await confinedPath(context, args.path, true);
    const operation = createHash('sha256')
      .update(context.idempotencyKey)
      .digest('hex')
      .slice(0, 24);
    const temporary = path.join(confined.parent, `.sazuz-${operation}-${randomUUID()}.tmp`);
    let pending = false;
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      pending = true;
      try {
        checkAbort(context.signal);
        await handle.writeFile(args.content, { encoding: 'utf8', signal: context.signal });
        await handle.sync();
      } finally {
        await handle.close();
      }
      checkAbort(context.signal);
      await verifyParents(context, confined);
      await rename(temporary, confined.target);
      pending = false;
      return expected;
    } finally {
      if (pending) await removeTemporary(temporary);
    }
  },
  async verify(context, args) {
    const expected = receipt(args);
    if (expected.bytes > maxWriteBytes) throw new ToolError('FILE_TOO_LARGE');
    let handle: FileHandle;
    try {
      handle = await openConfined(context, await confinedPath(context, args.path, false));
    } catch (error) {
      if (error instanceof ToolError && error.code === 'FILE_NOT_FOUND')
        return { status: 'not_done' };
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (stat.size !== expected.bytes) return { status: 'not_done' };
      checkAbort(context.signal);
      const content = await readBounded(handle, expected.bytes + 1, context.signal);
      const bytesRead = content.length;
      return bytesRead === expected.bytes &&
        createHash('sha256').update(content.subarray(0, bytesRead)).digest('hex') ===
          expected.sha256
        ? { status: 'done', result: expected }
        : { status: 'not_done' };
    } finally {
      await handle.close();
    }
  },
});
