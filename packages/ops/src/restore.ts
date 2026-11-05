import { parseSetting, type SettingsDocument } from '@sazuz/config/settings';
import { operationIdSchema, OperationsError } from '@sazuz/core/operations';
import { type BackupHeader } from '@sazuz/vault';
import { applySnapshotFiles, unpackSnapshot } from './archive.js';
import type { DatabaseSnapshot } from './postgres.js';
import { requireRestoreMigrations } from './migrations.js';

// SQL literals only, never shell input. All source values have passed strict application schemas.
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
export function recoverySql(input: {
  operationId: string;
  requestKey: string;
  inputHash: string;
  header: BackupHeader;
  settings: SettingsDocument;
  origin: string;
  rollback?: boolean;
}) {
  operationIdSchema.parse(input.operationId);
  if (
    !/^[a-f0-9]{64}$/.test(input.inputHash) ||
    !/^[A-Za-z0-9_:\-.]{1,160}$/.test(input.requestKey)
  )
    throw new OperationsError('OPS_INVALID');
  const general = parseSetting('general', {
    ...input.settings.general.value,
    baseUrl: input.origin,
  });
  const channels = parseSetting('channels', {
    ...input.settings.channels.value,
    webPush: false,
    telegramSecretRef: null,
    discordSecretRef: null,
    urgent: 'web',
    digest: 'web',
  });
  const changed: string[] = [];
  const revise = (namespace: 'general' | 'channels', value: unknown) => {
    const original = input.settings[namespace];
    const parsed = parseSetting(namespace, value);
    if (JSON.stringify(original.value) === JSON.stringify(parsed)) return;
    const version = original.version + 1;
    changed.push(`UPDATE settings SET value=${literal(JSON.stringify(parsed))}::jsonb,version=${version},updated_at=now() WHERE namespace=${literal(namespace)} AND version=${original.version};
      INSERT INTO settings_history(namespace,version,value,actor_id) SELECT namespace,version,value,'restore' FROM settings WHERE namespace=${literal(namespace)};
      SELECT pg_notify('settings_changed',${literal(namespace)});`);
  };
  revise('general', general);
  revise('channels', channels);
  // Never recreate dispatchable work from a historical snapshot. Retain all checkpoints/receipts.
  return `
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM installation WHERE workspace_id=${literal(input.header.workspaceId)} AND admin_id IS NOT NULL)
      THEN RAISE EXCEPTION 'Invalid restore installation'; END IF; END $$;
    DELETE FROM sessions; DELETE FROM setup_sessions; DELETE FROM verifications;
    DELETE FROM security_rate_limits; DELETE FROM auth_rate_limits; DELETE FROM execution_nonces;
    DELETE FROM worker_heartbeats; DELETE FROM worker_settings; DELETE FROM queue_outbox;
    UPDATE runs SET status='cancelled',reason='Historical snapshot restored. Start a new mission after reviewing external effects.',claim_key=NULL,worker_id=NULL,claimed_at=NULL,version=version+1,updated_at=now()
      WHERE status NOT IN ('completed','cancelled','failed','budget_exceeded');
    UPDATE approvals SET status='expired',version=version+1 WHERE status='pending';
    UPDATE triggers SET enabled=false,version=version+1,last_error='Restored: review and enable this automation explicitly.';
    UPDATE browser_sessions SET status='closed',version=version+1,updated_at=now() WHERE status IN ('opening','active');
    UPDATE notifications SET status='logged' WHERE status IN ('pending','deferred');
    UPDATE delivery_intents SET status='uncertain' WHERE status='intent';
    DO $$ BEGIN
      IF to_regclass('public.push_devices') IS NOT NULL THEN
        UPDATE push_devices SET revoked_at=now() WHERE revoked_at IS NULL;
        UPDATE push_deliveries SET status='uncertain',finished_at=now() WHERE status='intent';
        UPDATE speech_receipts SET status='uncertain',finished_at=now() WHERE status='intent';
      END IF;
    END $$;
    UPDATE operations SET status='interrupted',code='OPS_INTERRUPTED',finished_at=now() WHERE status IN ('queued','running','uploading','ready');
    ${input.rollback ? '' : "UPDATE backups SET status='unavailable' WHERE status='ready';"}
    INSERT INTO execution_control(id,paused,version) VALUES ('singleton',true,1) ON CONFLICT(id) DO UPDATE SET paused=true,version=execution_control.version+1,updated_at=now();
    UPDATE operation_gate SET operation_id=${literal(input.operationId)},updated_at=now();
    ${changed.join('\n')}
    INSERT INTO operations(id,kind,request_key,input_hash,user_id,status,stage,finished_at)
      SELECT ${literal(input.operationId)},'restore',${literal(input.requestKey)},${literal(input.inputHash)},admin_id,'done','restart-required',now() FROM installation
      ON CONFLICT(id) DO UPDATE SET status='done',stage='restart-required',code=NULL,finished_at=now();
    INSERT INTO audit_log(id,actor_id,action,target) VALUES (sazuz_audit_id(),'restore','backup.restored',${literal(input.header.id)});
    SELECT pg_notify('execution_changed','control');
    SELECT pg_notify('settings_changed',namespace) FROM settings;
    SELECT pg_notify('instance_restored',${literal(input.operationId)});
  `;
}
export async function restoreSnapshot(input: {
  payload: Uint8Array;
  header: BackupHeader;
  dataDir: string;
  database: DatabaseSnapshot;
  operationId: string;
  requestKey: string;
  inputHash: string;
  origin: string;
  rollback?: boolean;
  beforeApply?: () => void;
}) {
  const snapshot = unpackSnapshot(input.payload);
  // Compare with this release's files, never the candidate's potentially damaged
  // live database. Refuse incompatibility before converting or replacing anything.
  await requireRestoreMigrations(snapshot.migrations);
  const suffix = recoverySql({ ...input, settings: snapshot.settings });
  // Converting the entire custom-format dump catches malformed/truncated dumps before touching live files.
  const sql = await input.database.sql(
    snapshot.files.find((file) => file.path === 'database.pgdump')!.data,
  );
  try {
    input.beforeApply?.();
    await applySnapshotFiles(input.dataDir, snapshot.files);
    await input.database.restore(sql, suffix);
  } finally {
    sql.fill(0);
  }
}
