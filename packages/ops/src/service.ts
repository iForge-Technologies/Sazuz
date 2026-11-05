import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { CronExpressionParser } from 'cron-parser';
import type { InfraConfig } from '@sazuz/config';
import {
  auditLog,
  backups,
  installations,
  operations,
  operationGate,
  readSettings,
  workKey,
  type Database,
} from '@sazuz/db';
import { backupChecksum, openBackup, VaultError, type Vault } from '@sazuz/vault';
import {
  backupCreateSchema,
  backupIdSchema,
  backupSchema,
  backupStatusSchema,
  MAX_BACKUP_BYTES,
  operationIdSchema,
  operationSchema,
  OperationsError,
  restoreBeginSchema,
  restoreChunkSchema,
  restoreCompleteSchema,
  restoreUploadSchema,
} from '@sazuz/core/operations';
import { packSnapshot, snapshotFiles, type SnapshotFile } from './archive.js';
import { exclusiveOperation, recoverOperations } from './maintenance.js';
import { admitOperation } from './policy.js';
import { postgresSnapshot, type DatabaseSnapshot } from './postgres.js';
import { restoreSnapshot } from './restore.js';
import { OperationStorage } from './storage.js';
import { withSnapshotMigrations } from './migrations.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const publicOperation = (row: typeof operations.$inferSelect) =>
  operationSchema.parse({
    id: row.id,
    kind: row.kind,
    status: row.status,
    stage: row.stage,
    code: row.code,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  });
const backupView = (row: typeof backups.$inferSelect) =>
  backupSchema.parse({
    id: row.id,
    operationId: row.operationId,
    purpose: row.purpose,
    status: row.status,
    bytes: row.bytes,
    sha256: row.sha256,
    createdAt: row.createdAt.toISOString(),
  });
export function createOperations(options: {
  database: Database;
  config: InfraConfig;
  vault: Vault;
  snapshot?: DatabaseSnapshot;
}) {
  const db = options.database,
    storage = new OperationStorage(options.config.dataDir);
  const snapshot = options.snapshot ?? postgresSnapshot(options.config);
  let restartRequired = false;
  async function row(id: string) {
    const [found] = await db.orm
      .select()
      .from(operations)
      .where(eq(operations.id, operationIdSchema.parse(id)));
    if (!found) throw new OperationsError('OPS_NOT_FOUND');
    return found;
  }
  async function reserve(
    kind: 'backup' | 'restore',
    requestKey: string,
    input: unknown,
    userId: string | null,
    extra: Partial<typeof operations.$inferInsert> = {},
  ) {
    const inputHash = hash(input);
    const [created] = await db.orm
      .insert(operations)
      .values({
        id: workKey('op'),
        kind,
        requestKey,
        inputHash,
        userId,
        status: 'queued',
        ...extra,
      })
      .onConflictDoNothing()
      .returning();
    const existing =
      created ??
      (
        await db.orm
          .select()
          .from(operations)
          .where(and(eq(operations.kind, kind), eq(operations.requestKey, requestKey)))
      )[0];
    if (!existing || existing.inputHash !== inputHash || existing.userId !== userId)
      throw new OperationsError('OPS_CONFLICT');
    return { operation: existing, created: !!created };
  }
  const finish = (id: string, status: 'done' | 'failed', code: string | null = null) =>
    db.orm
      .update(operations)
      .set({ status, stage: status, code, finishedAt: new Date() })
      .where(eq(operations.id, id));
  async function status(userId: string) {
    const found = await db.orm
      .select()
      .from(backups)
      .where(eq(backups.userId, userId))
      .orderBy(desc(backups.createdAt))
      .limit(200);
    const receipts = await db.orm
      .select()
      .from(operations)
      .where(eq(operations.userId, userId))
      .orderBy(desc(operations.createdAt))
      .limit(50);
    return backupStatusSchema.parse({
      backups: found.map(backupView),
      operations: receipts.map(publicOperation),
      maximumBytes: MAX_BACKUP_BYTES,
    });
  }
  async function create(
    userId: string,
    input: unknown,
    purpose: 'manual' | 'scheduled' | 'pre-update' = 'manual',
    scheduleKey?: string,
    rollbackOperationId?: string,
    rollbackKey?: Uint8Array,
  ) {
    const request = backupCreateSchema.parse(input),
      requestKey = scheduleKey ?? request.requestId;
    const reserved = await reserve(
      'backup',
      requestKey,
      { purpose, rollbackOperationId: rollbackOperationId ?? null },
      userId,
    );
    const operation = reserved.operation;
    if (!reserved.created) return publicOperation(operation);
    let keepGate = false;
    try {
      await exclusiveOperation(
        db,
        rollbackOperationId ?? operation.id,
        async () => {
          await admitOperation(db, {
            actorId: userId,
            id: operation.id,
            action: 'backup',
            explicit: purpose !== 'scheduled',
          });
          const document = await readSettings(db);
          if (
            purpose === 'scheduled' &&
            (!document.backups.value.enabled ||
              !scheduleKey?.startsWith(`schedule:${document.backups.version}:`))
          )
            throw new OperationsError('OPS_CONFLICT');
          await db.orm
            .update(operations)
            .set({ status: 'running', stage: 'snapshot' })
            .where(eq(operations.id, operation.id));
          const backupId = workKey('bak'),
            createdAt = new Date().toISOString();
          const ciphertext = await options.vault.backup(
            () =>
              withSnapshotMigrations(db, async (migrations) => {
                const files: SnapshotFile[] = await snapshotFiles(options.config.dataDir);
                try {
                  files.push({
                    path: 'database.pgdump',
                    type: 'file',
                    data: await snapshot.dump(),
                  });
                  return packSnapshot({ files, settings: document, migrations });
                } finally {
                  for (const file of files) file.data.fill(0);
                }
              }),
            {
              id: backupId,
              createdAt,
              ...(rollbackOperationId ? { rollbackOperationId, rollbackKey } : {}),
            },
          );
          try {
            await storage.write(`${backupId}.sazuz`, ciphertext);
            await db.orm.transaction(async (tx) => {
              await tx.insert(backups).values({
                id: backupId,
                operationId: operation.id,
                userId,
                purpose,
                status: 'ready',
                bytes: ciphertext.length,
                sha256: backupChecksum(ciphertext),
                createdAt: new Date(createdAt),
              });
              await tx
                .update(operations)
                .set({ status: 'done', stage: 'done', finishedAt: new Date() })
                .where(eq(operations.id, operation.id));
              await tx.insert(auditLog).values({
                id: workKey('aud'),
                actorId: userId,
                action: 'backup.created',
                target: backupId,
              });
            });
            keepGate = purpose === 'pre-update' && rollbackOperationId !== undefined;
          } finally {
            ciphertext.fill(0);
          }
        },
        () => keepGate,
      );
    } catch (error) {
      await finish(
        operation.id,
        'failed',
        error instanceof OperationsError || error instanceof VaultError
          ? error.code
          : 'OPS_STORAGE',
      );
    }
    return publicOperation(await row(operation.id));
  }
  async function download(userId: string, id: string) {
    const [entry] = await db.orm
      .select()
      .from(backups)
      .where(
        and(
          eq(backups.id, backupIdSchema.parse(id)),
          eq(backups.userId, userId),
          eq(backups.status, 'ready'),
        ),
      );
    if (!entry) throw new OperationsError('OPS_NOT_FOUND');
    const bytes = await storage.read(`${entry.id}.sazuz`);
    if (bytes.length !== entry.bytes || backupChecksum(bytes) !== entry.sha256) {
      bytes.fill(0);
      throw new OperationsError('OPS_INVALID');
    }
    return { bytes, backup: backupView(entry) };
  }
  async function requireFresh() {
    const [installation] = await db.orm.select().from(installations);
    if (!installation || installation.adminId || installation.completedAt)
      throw new OperationsError('OPS_FRESH_REQUIRED');
  }
  async function uploadStatus(id: string) {
    const operation = await row(id);
    if (operation.kind !== 'restore' || operation.userId !== null)
      throw new OperationsError('OPS_NOT_FOUND');
    return restoreUploadSchema.parse({
      operation: publicOperation(operation),
      receivedBytes: operation.receivedBytes,
      bytes: operation.bytes,
    });
  }
  async function begin(input: unknown) {
    await requireFresh();
    const body = restoreBeginSchema.parse(input);
    const count = await db.orm
      .select({ count: sql<number>`count(*)::int` })
      .from(operations)
      .where(
        and(eq(operations.kind, 'restore'), sql`${operations.status} IN ('uploading','ready')`),
      );
    if (
      count[0]!.count >= 3 &&
      !(await db.orm.select().from(operations).where(eq(operations.requestKey, body.requestId)))
        .length
    )
      throw new OperationsError('OPS_LIMIT');
    const reserved = await reserve('restore', body.requestId, body, null, {
      bytes: body.bytes,
      sha256: body.sha256,
      status: 'uploading',
      stage: 'upload',
    });
    // Recover the reservation→empty-file gap without erasing an already uploaded prefix.
    try {
      const handle = await storage.open(`${reserved.operation.id}.upload`);
      await handle.close();
    } catch (error) {
      if (
        !(error instanceof OperationsError) ||
        error.code !== 'OPS_NOT_FOUND' ||
        reserved.operation.receivedBytes !== 0
      )
        throw error;
      try {
        await storage.write(`${reserved.operation.id}.upload`, Buffer.alloc(0));
      } catch (writeError) {
        if (
          !(writeError instanceof Error) ||
          !('code' in writeError) ||
          writeError.code !== 'EEXIST'
        )
          throw writeError;
      }
    }
    return uploadStatus(reserved.operation.id);
  }
  async function chunk(id: string, input: unknown) {
    await requireFresh();
    operationIdSchema.parse(id);
    const body = restoreChunkSchema.parse(input),
      data = Buffer.from(body.data, 'base64');
    if (!data.length || data.length > 65536 || data.toString('base64') !== body.data)
      throw new OperationsError('OPS_INVALID');
    await db.orm.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(operations)
        .where(
          and(eq(operations.id, id), isNull(operations.userId), eq(operations.kind, 'restore')),
        )
        .for('update');
      if (
        !operation ||
        !['uploading', 'ready'].includes(operation.status) ||
        body.offset > operation.receivedBytes ||
        body.offset + data.length > operation.bytes
      )
        throw new OperationsError('OPS_CONFLICT');
      const handle = await storage.open(`${id}.upload`, true);
      try {
        const size = (await handle.stat()).size;
        if (size < operation.receivedBytes || size > operation.bytes)
          throw new OperationsError('OPS_CONFLICT');
        const existingSize = Math.min(data.length, Math.max(0, size - body.offset));
        if (existingSize) {
          const existing = Buffer.alloc(existingSize);
          await handle.read(existing, 0, existingSize, body.offset);
          if (!existing.equals(data.subarray(0, existingSize)))
            throw new OperationsError('OPS_CONFLICT');
        }
        let written = existingSize;
        while (written < data.length) {
          const part = await handle.write(
            data,
            written,
            data.length - written,
            body.offset + written,
          );
          if (!part.bytesWritten) throw new OperationsError('OPS_STORAGE');
          written += part.bytesWritten;
        }
        await handle.sync();
        const receivedBytes = Math.max(operation.receivedBytes, body.offset + data.length);
        await tx
          .update(operations)
          .set({ receivedBytes, status: receivedBytes === operation.bytes ? 'ready' : 'uploading' })
          .where(eq(operations.id, id));
      } finally {
        await handle.close();
      }
    });
    return uploadStatus(id);
  }
  async function complete(id: string, input: unknown) {
    await requireFresh();
    const body = restoreCompleteSchema.parse(input);
    return exclusiveOperation(
      db,
      id,
      async () => {
        await requireFresh();
        const operation = await row(id);
        if (
          operation.kind !== 'restore' ||
          !['ready', 'failed', 'interrupted'].includes(operation.status) ||
          operation.receivedBytes !== operation.bytes
        )
          throw new OperationsError('OPS_CONFLICT');
        const ciphertext = await storage.read(`${id}.upload`);
        try {
          if (
            ciphertext.length !== operation.bytes ||
            backupChecksum(ciphertext) !== operation.sha256
          )
            throw new OperationsError('OPS_CREDENTIAL');
          const origin = (await readSettings(db)).general.value.baseUrl;
          await admitOperation(db, { actorId: 'setup', id, action: 'restore', explicit: true });
          await db.orm
            .update(operations)
            .set({ status: 'running', stage: 'restore', code: null })
            .where(eq(operations.id, id));
          await openBackup(ciphertext, body.credential, (payload, header) =>
            restoreSnapshot({
              payload,
              header,
              dataDir: options.config.dataDir,
              database: snapshot,
              operationId: id,
              requestKey: operation.requestKey,
              inputHash: operation.inputHash,
              origin,
              beforeApply: () => {
                restartRequired = true;
              },
            }),
          );
          return publicOperation(await row(id));
        } catch (error) {
          const safe =
            error instanceof VaultError
              ? new OperationsError('OPS_CREDENTIAL')
              : error instanceof OperationsError
                ? error
                : new OperationsError('OPS_STORAGE');
          await finish(id, 'failed', safe.code);
          throw safe;
        } finally {
          ciphertext.fill(0);
        }
      },
      () => restartRequired,
    );
  }
  async function tick(now = new Date()) {
    if (restartRequired) return;
    await recoverOperations(db);
    if ((await db.orm.select().from(operationGate))[0]?.operationId) return;
    const [installation] = await db.orm.select().from(installations);
    if (!installation?.completedAt || !installation.adminId) return;
    const document = await readSettings(db),
      configured = document.backups;
    if (!configured.value.enabled) return;
    let due: Date;
    try {
      due = CronExpressionParser.parse(configured.value.schedule, {
        tz: document.general.value.timezone,
        currentDate: new Date(now.getTime() + 1),
      })
        .prev()
        .toDate();
    } catch {
      throw new OperationsError('OPS_INVALID');
    }
    if (now.getTime() - due.getTime() <= 65000) {
      const key = `schedule:${configured.version}:${due.toISOString()}`;
      await create(
        installation.adminId,
        { requestId: '00000000-0000-4000-8000-000000000000' },
        'scheduled',
        key,
      );
    }
    if (configured.value.prune) {
      const cutoff = new Date(now.getTime() - configured.value.retentionDays * 86400000);
      const candidates = await db.orm
        .select()
        .from(backups)
        .where(
          and(
            eq(backups.userId, installation.adminId),
            sql`${backups.status} IN ('ready','deleting')`,
            sql`${backups.createdAt}<${cutoff}`,
          ),
        )
        .limit(50);
      for (const entry of candidates) {
        await admitOperation(db, {
          actorId: installation.adminId,
          id: entry.operationId,
          action: 'prune',
          explicit: false,
        });
        // Deletion is idempotent; mark intent in the durable inventory before removing ciphertext.
        await db.orm.update(backups).set({ status: 'deleting' }).where(eq(backups.id, entry.id));
        await storage.remove(`${entry.id}.sazuz`);
        await db.orm.update(backups).set({ status: 'deleted' }).where(eq(backups.id, entry.id));
        await db.orm.insert(auditLog).values({
          id: workKey('aud'),
          actorId: installation.adminId,
          action: 'backup.deleted',
          target: entry.id,
        });
      }
    }
  }
  return {
    get restartRequired() {
      return restartRequired;
    },
    status,
    create,
    download,
    begin,
    chunk,
    complete,
    uploadStatus,
    tick,
    storage,
    requireFresh,
  };
}
export type Operations = ReturnType<typeof createOperations>;
