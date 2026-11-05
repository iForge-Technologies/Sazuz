import { z } from 'zod';

export const operationIdSchema = z.string().regex(/^op_[0-9A-HJKMNP-TV-Z]{26}$/);
export const backupIdSchema = z.string().regex(/^bak_[0-9A-HJKMNP-TV-Z]{26}$/);
export const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
export const MAX_BACKUP_FILE_BYTES = MAX_BACKUP_BYTES + 65536;
export const operationSchema = z.strictObject({
  id: operationIdSchema,
  kind: z.enum(['backup', 'restore', 'update']),
  status: z.enum(['queued', 'running', 'uploading', 'ready', 'done', 'failed', 'interrupted']),
  stage: z.string().max(64),
  code: z.string().max(64).nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export const backupSchema = z.strictObject({
  id: backupIdSchema,
  operationId: operationIdSchema,
  createdAt: z.iso.datetime(),
  bytes: z.number().int().nonnegative().max(MAX_BACKUP_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  purpose: z.enum(['manual', 'scheduled', 'pre-update']),
  status: z.enum(['ready', 'deleting', 'deleted', 'unavailable']),
});
export const backupStatusSchema = z.strictObject({
  backups: z.array(backupSchema).max(200),
  operations: z.array(operationSchema).max(50),
  maximumBytes: z.literal(MAX_BACKUP_BYTES),
});
export const backupCreateSchema = z.strictObject({ requestId: z.uuid() });
export const releaseImageSchema = z
  .string()
  .max(300)
  .regex(
    /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/,
  );
export const installedImageSchema = z.union([
  releaseImageSchema,
  z.string().regex(/^sha256:[a-f0-9]{64}$/),
]);
export const releaseSchema = z.strictObject({
  format: z.literal(1),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/)
    .max(64),
  image: releaseImageSchema,
  notes: z.string().trim().min(1).max(12000),
});
export const updatePrepareSchema = z.strictObject({
  requestId: z.uuid(),
  previousImage: installedImageSchema,
  release: releaseSchema,
});
export const updateStageSchema = z.enum([
  'preparing',
  'backed-up',
  'pulling',
  'migrating',
  'checking',
  'activation-intent',
  'done',
  'rolling-back',
  'restored',
  'rolled-back',
  'aborted',
]);
export const updateStatusSchema = z.strictObject({
  operationId: operationIdSchema,
  stage: updateStageSchema,
  release: releaseSchema,
  previousImage: installedImageSchema,
  backupId: backupIdSchema.nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export const restoreBeginSchema = z.strictObject({
  requestId: z.uuid(),
  bytes: z.number().int().min(64).max(MAX_BACKUP_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const restoreChunkSchema = z.strictObject({
  offset: z.number().int().min(0).max(MAX_BACKUP_FILE_BYTES),
  data: z
    .string()
    .min(4)
    .max(87384)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export const restoreUploadSchema = z.strictObject({
  operation: operationSchema,
  receivedBytes: z.number().int().nonnegative(),
  bytes: z.number().int().positive(),
});
export const restoreCompleteSchema = z.strictObject({
  credential: z.string().min(1).max(256),
  confirm: z.literal('restore'),
});
const messages = {
  OPS_INVALID: 'The operation or archive is invalid.',
  OPS_LIMIT: 'The snapshot exceeds the supported 128 MiB archive limit.',
  OPS_UNSAFE_PATH:
    'A snapshot file or directory is unsafe. Links and special files are not supported.',
  OPS_BUSY:
    'Another operation or active execution is still running. Wait for it to stop and retry.',
  OPS_CONFLICT: 'This operation changed or the request was reused with different input.',
  OPS_NOT_FOUND: 'The operation or backup was not found.',
  OPS_CREDENTIAL: 'The backup credential is incorrect or the archive was modified.',
  OPS_STORAGE: 'Private operation storage is unavailable.',
  OPS_DATABASE:
    'The PostgreSQL snapshot operation failed. The original database transaction was preserved.',
  OPS_MIGRATIONS:
    'Installed migration files and database history must match. Complete or recover the update before creating a backup.',
  OPS_RESTORE_VERSION:
    'This snapshot requires the release that created it. Install the matching release, restore, and then update normally. Unmarked pre-release snapshots require their original build.',
  OPS_POLICY: 'Current policy blocks this operation.',
  OPS_INTERRUPTED:
    'The operation was interrupted. Inspect its status before starting a new request.',
  OPS_FRESH_REQUIRED:
    'Restore through the wizard requires a fresh installation without an owner account.',
  OPS_UPDATE_STATE:
    'The update state cannot advance safely. Use sazuz update recover and inspect Updates.',
  OPS_UPDATE_ACTIVATION:
    'Activation could not be verified. Keep the recovery journal and inspect the instance before rollback.',
} as const;
export class OperationsError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'OperationsError';
  }
}
