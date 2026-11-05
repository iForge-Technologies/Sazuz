import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { preparePrivateSecretDirectory } from '@sazuz/config/private-files';
import { MAX_BACKUP_FILE_BYTES, OperationsError } from '@sazuz/core/operations';

const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const validName =
  /^(?:bak_[0-9A-HJKMNP-TV-Z]{26}\.sazuz|op_[0-9A-HJKMNP-TV-Z]{26}\.(?:upload|json)|update\.json)$/;
export class OperationStorage {
  #directory: Promise<string> | undefined;
  constructor(readonly dataDir: string) {}
  async path(name: string) {
    if (!validName.test(name)) throw new OperationsError('OPS_INVALID');
    this.#directory ??= (async () => {
      await preparePrivateSecretDirectory(this.dataDir);
      const root = await realpath(this.dataDir),
        directory = join(root, 'operations');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      return directory;
    })();
    const directory = await this.#directory;
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== directory)
      throw new OperationsError('OPS_UNSAFE_PATH');
    return join(directory, name);
  }
  async open(name: string, writable = false) {
    const path = await this.path(name);
    let before;
    try {
      before = await lstat(path);
    } catch (error) {
      throw new OperationsError(
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? 'OPS_NOT_FOUND'
          : 'OPS_STORAGE',
      );
    }
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > MAX_BACKUP_FILE_BYTES
    )
      throw new OperationsError('OPS_UNSAFE_PATH');
    const handle = await open(path, (writable ? constants.O_RDWR : constants.O_RDONLY) | noFollow);
    const after = await handle.stat();
    if (after.ino !== before.ino || after.dev !== before.dev || after.nlink !== 1) {
      await handle.close();
      throw new OperationsError('OPS_UNSAFE_PATH');
    }
    return handle;
  }
  async read(name: string) {
    const handle = await this.open(name);
    try {
      const size = (await handle.stat()).size,
        data = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const read = await handle.read(data, offset, size - offset, offset);
        if (!read.bytesRead) throw new OperationsError('OPS_STORAGE');
        offset += read.bytesRead;
      }
      if ((await handle.stat()).size !== size) throw new OperationsError('OPS_BUSY');
      return data;
    } finally {
      await handle.close();
    }
  }
  async write(name: string, data: Uint8Array, replace = false) {
    if (data.length > MAX_BACKUP_FILE_BYTES) throw new OperationsError('OPS_LIMIT');
    const target = await this.path(name);
    const temp = target + '.' + randomUUID();
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (replace) await rename(temp, target);
    else {
      try {
        await link(temp, target);
      } finally {
        await unlink(temp);
      }
    }
    if (process.platform !== 'win32') {
      const directory = await open(await this.#directory!, constants.O_RDONLY | noFollow);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }
  async remove(name: string) {
    const path = await this.path(name);
    try {
      const handle = await this.open(name);
      await handle.close();
    } catch (error) {
      if (error instanceof OperationsError && error.code === 'OPS_NOT_FOUND') return;
      throw error;
    }
    await unlink(path);
  }
}
