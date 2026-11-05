import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { readInfraConfig, readPlumbing } from '@sazuz/config';
import { createLogger } from '@sazuz/core';
import { createDatabase } from '@sazuz/db';
import { secretRedactor } from '@sazuz/vault';
import { readUpdate, updateLocal } from '@sazuz/ops';
import {
  MAX_BACKUP_FILE_BYTES,
  operationIdSchema,
  backupStatusSchema,
  operationSchema,
  restoreUploadSchema,
  releaseSchema,
  installedImageSchema,
  updateStatusSchema,
  OperationsError,
} from '@sazuz/core/operations';

export async function boundedInput(
  input: AsyncIterable<Uint8Array>,
  maximum = MAX_BACKUP_FILE_BYTES,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of input) {
      size += chunk.length;
      if (size > maximum) throw new OperationsError('OPS_LIMIT');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}
export async function runOperationsCli(
  args: string[],
  prompt: (label: string) => Promise<string>,
  output: (message: string) => void,
  io: {
    input?: AsyncIterable<Uint8Array>;
    binary?: (bytes: Uint8Array) => Promise<void> | void;
  } = {},
) {
  const parsed = z
    .union([
      z.tuple([z.literal('backup'), z.literal('--stream')]),
      z.tuple([z.literal('restore-upload')]),
      z.tuple([z.literal('restore-complete'), operationIdSchema]),
      z.tuple([z.literal('update-prepare'), z.literal('--stdin'), installedImageSchema]),
      z.tuple([z.literal('update-activate')]),
      z.tuple([
        z.literal('update-local'),
        z.enum([
          'state',
          'candidate',
          'pulling',
          'migrating',
          'checking',
          'rollback',
          'finish-rollback',
          'abort',
          'reconcile',
        ]),
      ]),
    ])
    .safeParse(args);
  if (!parsed.success) throw new OperationsError('OPS_INVALID');
  const input = parsed.data,
    config = readInfraConfig();
  if (input[0] === 'update-local') {
    if (input[1] === 'state' || input[1] === 'candidate') {
      const journal = await readUpdate(config.dataDir);
      if (!journal) {
        if (input[1] === 'state') {
          output('none');
          return;
        }
        throw new OperationsError('OPS_UPDATE_STATE');
      }
      output(input[1] === 'state' ? journal.stage : journal.release.image);
      return;
    }
    const db = await createDatabase(config, createLogger('operations-cli', secretRedactor));
    try {
      output((await updateLocal(input[1], { database: db, config })).stage);
    } finally {
      await db.close();
    }
    return;
  }
  const base = new URL(config.serverUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
    throw new OperationsError('OPS_POLICY');
  const plumbing = await readPlumbing(config.dataDir);
  async function request(path: string, body?: unknown, binary = false) {
    const response = await fetch(new URL(`/api/operator/${path}`, base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${plumbing.operatorKey}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(150000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new OperationsError('OPS_UPDATE_STATE');
    }
    if (binary) {
      if (!response.body || response.headers.get('content-type') !== 'application/octet-stream')
        throw new OperationsError('OPS_INVALID');
      const reader = response.body.getReader();
      async function* chunks() {
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) return;
            yield part.value;
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      }
      return boundedInput(chunks());
    }
    return response.json() as Promise<unknown>;
  }
  if (input[0] === 'update-prepare') {
    const manifest = await boundedInput(io.input ?? process.stdin, 32768);
    let release;
    try {
      release = releaseSchema.parse(JSON.parse(manifest.toString('utf8')));
    } finally {
      manifest.fill(0);
    }
    const state = updateStatusSchema.parse(
      await request('operations/updates/prepare', {
        requestId: randomUUID(),
        release,
        previousImage: input[2],
      }),
    );
    if (state.stage !== 'backed-up') throw new OperationsError('OPS_UPDATE_STATE');
    output(state.release.image);
    return;
  }
  if (input[0] === 'update-activate') {
    const state = updateStatusSchema.parse(await request('operations/updates/activate', {}));
    if (state.stage !== 'done') throw new OperationsError('OPS_UPDATE_ACTIVATION');
    output(state.stage);
    return;
  }
  if (input[0] === 'backup') {
    const operation = operationSchema.parse(await request('backups', { requestId: randomUUID() }));
    if (operation.status !== 'done') throw new OperationsError('OPS_UPDATE_STATE');
    const inventory = backupStatusSchema.parse(await request('backups'));
    const entry = inventory.backups.find(
      (item) => item.operationId === operation.id && item.status === 'ready',
    );
    if (!entry) throw new OperationsError('OPS_NOT_FOUND');
    const bytes = await request(`backups/${entry.id}/download`, undefined, true);
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length !== entry.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== entry.sha256
    )
      throw new OperationsError('OPS_INVALID');
    try {
      await (
        io.binary ??
        ((data) =>
          new Promise<void>((resolve, reject) => {
            process.stdout.write(data, (error) =>
              error ? reject(new OperationsError('OPS_STORAGE')) : resolve(),
            );
          }))
      )(bytes);
    } finally {
      bytes.fill(0);
    }
    return;
  }
  if (input[0] === 'restore-upload') {
    const bytes = await boundedInput(io.input ?? process.stdin);
    try {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const requestId = `${sha256.slice(0, 8)}-${sha256.slice(8, 12)}-4${sha256.slice(13, 16)}-8${sha256.slice(17, 20)}-${sha256.slice(20, 32)}`;
      let upload = restoreUploadSchema.parse(
        await request('setup/restore', { requestId, bytes: bytes.length, sha256 }),
      );
      while (upload.receivedBytes < bytes.length) {
        const offset = upload.receivedBytes;
        upload = restoreUploadSchema.parse(
          await request(`setup/restore/${upload.operation.id}/chunks`, {
            offset,
            data: bytes.subarray(offset, offset + 65536).toString('base64'),
          }),
        );
        if (upload.receivedBytes <= offset || upload.bytes !== bytes.length)
          throw new OperationsError('OPS_CONFLICT');
      }
      output(upload.operation.id);
      return;
    } finally {
      bytes.fill(0);
    }
  }
  const credential = await prompt('Original vault passphrase or recovery key');
  secretRedactor.register(credential);
  const result = operationSchema.parse(
    await request(`setup/restore/${input[1]}/complete`, { credential, confirm: 'restore' }),
  );
  if (result.status !== 'done') throw new OperationsError('OPS_UPDATE_STATE');
  output('Restore completed. Wait for restart, sign in, and review stopped work before resuming.');
}
