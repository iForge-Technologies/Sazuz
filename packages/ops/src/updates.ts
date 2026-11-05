import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { InfraConfig } from '@sazuz/config';
import {
  readPrivateFiles,
  writePrivateFileOnce,
  removePrivateFile,
} from '@sazuz/config/private-files';
import {
  readSettings,
  operations,
  operationGate,
  backups,
  auditLog,
  workKey,
  type Database,
} from '@sazuz/db';
import { backupChecksum, openRollbackBackup, secretRedactor, type Vault } from '@sazuz/vault';
import {
  operationIdSchema,
  backupIdSchema,
  installedImageSchema,
  releaseSchema,
  updatePrepareSchema,
  updateStageSchema,
  updateStatusSchema,
  OperationsError,
} from '@sazuz/core/operations';
import { OperationStorage } from './storage.js';
import { admitOperation } from './policy.js';
import { postgresSnapshot, type DatabaseSnapshot } from './postgres.js';
import { restoreSnapshot } from './restore.js';
import type { Operations } from './service.js';

const journalSchema = z.strictObject({
  format: z.literal(1),
  id: operationIdSchema,
  userId: z.string().min(1).max(200),
  requestId: z.uuid(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  release: releaseSchema,
  previousImage: installedImageSchema,
  stage: updateStageSchema,
  backup: z
    .strictObject({
      id: backupIdSchema,
      operationId: operationIdSchema,
      createdAt: z.iso.datetime(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.number().int().positive(),
    })
    .nullable(),
  origin: z.url().max(2048),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type UpdateJournal = z.infer<typeof journalSchema>;
const terminal = (stage: UpdateJournal['stage']) =>
  ['done', 'rolled-back', 'aborted'].includes(stage);
const keyName = (id: string) => `update-${operationIdSchema.parse(id).slice(3).toLowerCase()}.key`;
export async function readUpdate(dataDir: string): Promise<UpdateJournal | null> {
  try {
    const bytes = await new OperationStorage(dataDir).read('update.json');
    if (bytes.length > 32768) throw new OperationsError('OPS_UPDATE_STATE');
    return journalSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (error instanceof OperationsError && error.code === 'OPS_NOT_FOUND') return null;
    throw new OperationsError('OPS_UPDATE_STATE');
  }
}
export const updateView = (journal: UpdateJournal) =>
  updateStatusSchema.parse({
    operationId: journal.id,
    stage: journal.stage,
    release: journal.release,
    previousImage: journal.previousImage,
    backupId: journal.backup?.id ?? null,
    startedAt: journal.startedAt,
    finishedAt: journal.finishedAt,
  });
async function writeJournal(dataDir: string, journal: UpdateJournal, replace = true) {
  await new OperationStorage(dataDir).write(
    'update.json',
    Buffer.from(JSON.stringify(journalSchema.parse(journal))),
    replace,
  );
}
async function removeKey(config: InfraConfig, journal: UpdateJournal) {
  // Generated, operation-bound infrastructure key; never a user secret or a master-key copy.
  await removePrivateFile(config.dataDir, keyName(journal.id));
}
async function gateMatches(db: Database, journal: UpdateJournal) {
  const result = await db.pool.query<{ matches: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM operation_gate g JOIN operations o ON o.id=g.operation_id
    WHERE g.id='singleton' AND o.id=$1 AND o.kind='update' AND o.status='running') AS matches`,
    [journal.id],
  );
  return result.rows[0]?.matches === true;
}
export function createUpdates(options: {
  database: Database;
  config: InfraConfig;
  vault: Vault;
  backups: Operations;
}) {
  const db = options.database,
    config = options.config;
  async function status(userId: string) {
    const journal = await readUpdate(config.dataDir);
    if (!journal || journal.userId !== userId) return null;
    return updateView(journal);
  }
  async function prepare(userId: string, raw: unknown) {
    const input = updatePrepareSchema.parse(raw);
    input.release.notes = secretRedactor.redactText(input.release.notes);
    const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const lease = await db.coordination.connect();
    let owned = false;
    try {
      owned =
        (await lease.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(72839113) AS locked'))
          .rows[0]?.locked ?? false;
      if (!owned) throw new OperationsError('OPS_BUSY');
      const prior = await readUpdate(config.dataDir);
      if (prior?.requestId === input.requestId) {
        if (prior.inputHash !== inputHash || prior.userId !== userId)
          throw new OperationsError('OPS_CONFLICT');
        return updateView(prior);
      }
      if (prior && !terminal(prior.stage)) throw new OperationsError('OPS_UPDATE_STATE');
      const id = workKey('op');
      await admitOperation(db, { actorId: userId, id, action: 'update', explicit: true });
      // Authorize compensation before a candidate can damage policy storage.
      await admitOperation(db, { actorId: userId, id, action: 'restore', explicit: true });
      const journal: UpdateJournal = {
        format: 1,
        id,
        userId,
        requestId: input.requestId,
        inputHash,
        release: input.release,
        previousImage: input.previousImage,
        stage: 'preparing',
        backup: null,
        origin: (await readSettings(db)).general.value.baseUrl,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      if (prior)
        await new OperationStorage(config.dataDir).write(
          `${prior.id}.json`,
          Buffer.from(JSON.stringify(prior)),
          true,
        );
      await writeJournal(config.dataDir, journal, prior !== null);
      const recoveryKey = randomBytes(32);
      try {
        const encoded = recoveryKey.toString('base64url');
        secretRedactor.register(encoded);
        const keyFile = Buffer.from(encoded);
        try {
          await writePrivateFileOnce(config.dataDir, keyName(id), keyFile);
        } finally {
          keyFile.fill(0);
        }
        await db.orm.insert(operations).values({
          id,
          kind: 'update',
          userId,
          requestKey: input.requestId,
          inputHash,
          status: 'running',
          stage: 'preparing',
          metadata: { release: input.release, previousImage: input.previousImage },
        });
        const operation = await options.backups.create(
          userId,
          { requestId: input.requestId },
          'pre-update',
          `pre-update:${id}`,
          id,
          recoveryKey,
        );
        if (operation.status !== 'done') throw new OperationsError('OPS_UPDATE_STATE');
        const [backup] = await db.orm
          .select()
          .from(backups)
          .where(eq(backups.operationId, operation.id));
        if (!backup) throw new OperationsError('OPS_UPDATE_STATE');
        journal.backup = {
          id: backup.id,
          operationId: backup.operationId,
          createdAt: backup.createdAt.toISOString(),
          bytes: backup.bytes,
          sha256: backup.sha256,
        };
        journal.stage = 'backed-up';
        await writeJournal(config.dataDir, journal);
        await db.orm
          .update(operations)
          .set({
            stage: 'backed-up',
            metadata: {
              release: input.release,
              previousImage: input.previousImage,
              backupId: backup.id,
            },
          })
          .where(eq(operations.id, id));
        return updateView(journal);
      } catch {
        // No host mutation is allowed until the complete backed-up journal was returned.
        if (!journal.backup) {
          journal.stage = 'aborted';
          journal.finishedAt = new Date().toISOString();
          await writeJournal(config.dataDir, journal);
          await db.orm.transaction(async (tx) => {
            await tx
              .update(operations)
              .set({
                status: 'failed',
                stage: 'aborted',
                code: 'OPS_UPDATE_STATE',
                finishedAt: new Date(),
              })
              .where(eq(operations.id, id));
            await tx
              .update(operationGate)
              .set({ operationId: null, updatedAt: new Date() })
              .where(eq(operationGate.operationId, id));
          });
          await removeKey(config, journal);
        }
        throw new OperationsError('OPS_UPDATE_STATE');
      } finally {
        recoveryKey.fill(0);
      }
    } finally {
      try {
        if (owned) await lease.query('SELECT pg_advisory_unlock(72839113)');
        lease.release();
      } catch {
        lease.release(true);
        db.logger.warn({ code: 'UPDATE_LEASE_LOST' }, 'The update preparation lease was closed.');
      }
    }
  }
  async function activate() {
    const journal = await readUpdate(config.dataDir);
    if (!journal || !['checking', 'activation-intent', 'done'].includes(journal.stage))
      throw new OperationsError('OPS_UPDATE_STATE');
    if (journal.stage === 'done') {
      await removeKey(config, journal);
      return updateView(journal);
    }
    if (journal.stage === 'activation-intent') {
      const state = await updateLocal('reconcile', { database: db, config });
      if (state.stage === 'done') return updateView(state);
    }
    if (!(await gateMatches(db, journal))) throw new OperationsError('OPS_UPDATE_ACTIVATION');
    journal.stage = 'activation-intent';
    await writeJournal(config.dataDir, journal);
    await db.orm.transaction(async (tx) => {
      const [changed] = await tx
        .update(operationGate)
        .set({ operationId: null, updatedAt: new Date() })
        .where(eq(operationGate.operationId, journal.id))
        .returning();
      if (!changed) throw new OperationsError('OPS_UPDATE_ACTIVATION');
      await tx
        .update(operations)
        .set({ status: 'done', stage: 'done', code: null, finishedAt: new Date() })
        .where(eq(operations.id, journal.id));
      await tx.insert(auditLog).values({
        id: workKey('aud'),
        actorId: journal.userId,
        action: 'update.activated',
        target: journal.id,
      });
    });
    journal.stage = 'done';
    journal.finishedAt = new Date().toISOString();
    await writeJournal(config.dataDir, journal);
    await removeKey(config, journal);
    return updateView(journal);
  }
  return { status, prepare, activate };
}

/** Trusted one-shot host recovery: workers/server are stopped before rollback. No vault unlock or app schema is required to read the journal. */
export async function updateLocal(
  action:
    'pulling' | 'migrating' | 'checking' | 'rollback' | 'finish-rollback' | 'abort' | 'reconcile',
  options: { database: Database; config: InfraConfig; snapshot?: DatabaseSnapshot },
) {
  const { database: db, config } = options;
  const journal = await readUpdate(config.dataDir);
  if (!journal) throw new OperationsError('OPS_UPDATE_STATE');
  if (action === 'reconcile') {
    if (terminal(journal.stage)) {
      await removeKey(config, journal);
      return journal;
    }
    if (journal.stage !== 'activation-intent') return journal;
    const [row] = await db.orm.select().from(operations).where(eq(operations.id, journal.id));
    if (row?.kind === 'update' && row.status === 'done' && row.stage === 'done') {
      journal.stage = 'done';
      journal.finishedAt = row.finishedAt?.toISOString() ?? new Date().toISOString();
      await writeJournal(config.dataDir, journal);
      await removeKey(config, journal);
      return journal;
    }
    if (!(await gateMatches(db, journal))) throw new OperationsError('OPS_UPDATE_ACTIVATION');
    journal.stage = 'checking';
    await writeJournal(config.dataDir, journal);
    return journal;
  }
  if (action === 'abort') {
    if (!['preparing', 'aborted'].includes(journal.stage))
      throw new OperationsError('OPS_UPDATE_STATE');
    await db.orm.transaction(async (tx) => {
      await tx
        .update(operationGate)
        .set({ operationId: null, updatedAt: new Date() })
        .where(eq(operationGate.operationId, journal.id));
      await tx
        .update(operations)
        .set({
          status: 'failed',
          stage: 'aborted',
          code: 'OPS_INTERRUPTED',
          finishedAt: new Date(),
        })
        .where(eq(operations.id, journal.id));
    });
    journal.stage = 'aborted';
    journal.finishedAt = new Date().toISOString();
    await writeJournal(config.dataDir, journal);
    await removeKey(config, journal);
    return journal;
  }
  if (action === 'rollback') {
    if (journal.stage === 'restored' || journal.stage === 'rolled-back') return journal;
    if (
      !journal.backup ||
      !['backed-up', 'pulling', 'migrating', 'checking', 'rolling-back'].includes(journal.stage)
    )
      throw new OperationsError('OPS_UPDATE_STATE');
    const storage = new OperationStorage(config.dataDir);
    const bytes = await storage.read(`${journal.backup.id}.sazuz`);
    const keys = await readPrivateFiles(config.dataDir, [
      { name: keyName(journal.id), maxBytes: 44 },
    ]);
    const encoded = z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse(keys.get(keyName(journal.id))?.toString('utf8'));
    secretRedactor.register(encoded);
    const key = Buffer.from(encoded, 'base64url');
    try {
      if (bytes.length !== journal.backup.bytes || backupChecksum(bytes) !== journal.backup.sha256)
        throw new OperationsError('OPS_CREDENTIAL');
      journal.stage = 'rolling-back';
      await writeJournal(config.dataDir, journal);
      await openRollbackBackup(bytes, journal.id, key, (payload, header) =>
        restoreSnapshot({
          payload,
          header,
          dataDir: config.dataDir,
          database: options.snapshot ?? postgresSnapshot(config),
          operationId: journal.id,
          requestKey: journal.requestId,
          inputHash: journal.inputHash,
          origin: journal.origin,
          rollback: true,
        }),
      );
      // The snapshot was captured before its own inventory transaction. Retain its
      // download entry as well as the external recovery receipt after rollback.
      const backup = journal.backup;
      await db.orm.transaction(async (tx) => {
        await tx
          .update(operations)
          .set({ status: 'done', stage: 'done', code: null, finishedAt: new Date() })
          .where(eq(operations.id, backup.operationId));
        await tx
          .insert(backups)
          .values({
            id: backup.id,
            operationId: backup.operationId,
            userId: journal.userId,
            purpose: 'pre-update',
            status: 'ready',
            bytes: backup.bytes,
            sha256: backup.sha256,
            createdAt: new Date(backup.createdAt),
          })
          .onConflictDoNothing();
      });
      journal.stage = 'restored';
      await writeJournal(config.dataDir, journal);
      return journal;
    } finally {
      key.fill(0);
      bytes.fill(0);
      for (const value of keys.values()) value.fill(0);
    }
  }
  if (action === 'finish-rollback') {
    if (journal.stage === 'rolled-back') {
      await removeKey(config, journal);
      return journal;
    }
    if (journal.stage !== 'restored') throw new OperationsError('OPS_UPDATE_STATE');
    await db.orm.transaction(async (tx) => {
      await tx
        .update(operationGate)
        .set({ operationId: null, updatedAt: new Date() })
        .where(eq(operationGate.operationId, journal.id));
      await tx
        .update(operations)
        .set({
          status: 'failed',
          stage: 'rolled-back',
          code: 'UPDATE_ROLLED_BACK',
          finishedAt: new Date(),
        })
        .where(eq(operations.id, journal.id));
      await tx.insert(auditLog).values({
        id: workKey('aud'),
        actorId: journal.userId,
        action: 'update.rolled-back',
        target: journal.id,
      });
    });
    journal.stage = 'rolled-back';
    journal.finishedAt = new Date().toISOString();
    await writeJournal(config.dataDir, journal);
    await removeKey(config, journal);
    return journal;
  }
  const before = { pulling: 'backed-up', migrating: 'pulling', checking: 'migrating' } as const;
  if (journal.stage === action) return journal;
  if (journal.stage !== before[action]) throw new OperationsError('OPS_UPDATE_STATE');
  if (!(await gateMatches(db, journal))) throw new OperationsError('OPS_UPDATE_STATE');
  journal.stage = action;
  await writeJournal(config.dataDir, journal);
  await db.orm.update(operations).set({ stage: action }).where(eq(operations.id, journal.id));
  return journal;
}
