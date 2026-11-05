'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  backupStatusSchema,
  operationSchema,
  restoreUploadSchema,
  MAX_BACKUP_FILE_BYTES,
} from '@sazuz/core/operations';
import type { z } from 'zod';
import { api } from '../lib/api';

export function BackupControls({ ready }: { ready: boolean }) {
  const [status, setStatus] = useState<z.infer<typeof backupStatusSchema> | null>(null);
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const request = useRef<string | null>(null);
  const refresh = useCallback(async () => setStatus(await api('backups', backupStatusSchema)), []);
  useEffect(() => {
    void refresh().catch(() => setMessage('Backups could not be loaded.'));
  }, [refresh]);
  return (
    <section className="configuration-section backup-section" aria-label="Backups">
      <h2>Encrypted snapshots</h2>
      <p>
        Includes the database, workspace files and vault. Save the downloaded file with your
        recovery kit. Snapshots support up to 128 MiB. Close active browser sessions before
        starting.
      </p>
      <button
        disabled={busy || !ready}
        onClick={() => {
          setBusy(true);
          setMessage('Waiting for active work to finish, then creating the snapshot…');
          request.current ??= crypto.randomUUID();
          void api('backups', operationSchema, { requestId: request.current })
            .then(async (operation) => {
              setMessage(
                operation.status === 'done'
                  ? 'Encrypted backup is ready to download.'
                  : `Backup ${operation.status}. ${operation.code ?? 'Inspect the operation below.'}`,
              );
              request.current = null;
              await refresh();
            })
            .catch((cause) =>
              setMessage(cause instanceof Error ? cause.message : 'Backup could not complete.'),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Creating backup…' : 'Create encrypted backup'}
      </button>
      <p role="status">{message}</p>
      {status && (
        <>
          <ul className="backup-list">
            {status.backups.map((backup) => (
              <li key={backup.id}>
                <div className="backup-record">
                  <time>{new Date(backup.createdAt).toLocaleString()}</time>
                  <span>
                    {backup.purpose} · {(backup.bytes / 1024).toFixed(1)} KiB · {backup.status}
                  </span>
                </div>
                {backup.status === 'ready' && (
                  <a href={`/api/backups/${backup.id}/download`}>Download encrypted backup</a>
                )}
              </li>
            ))}
          </ul>
          {!status.backups.length && <p>No backups yet.</p>}
          <details className="setup-details">
            <summary>Operation history</summary>
            <ul>
              {status.operations.map((operation) => (
                <li key={operation.id}>
                  {new Date(operation.createdAt).toLocaleString()} · {operation.kind} ·{' '}
                  {operation.status} · {operation.code ?? operation.stage}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      <p>
        Scheduled snapshots use the timezone in General. Automatic retention deletion requires the
        option below and current policy permission. A locked Strict vault records a failed backup;
        unlock it before the next schedule.
      </p>
      <p>
        Restore from the welcome screen of a fresh installation, or use <code>sazuz restore</code>{' '}
        on that host.
      </p>
    </section>
  );
}

export function RestoreBackup() {
  const [file, setFile] = useState<File | null>(null),
    [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [done, setDone] = useState(false);
  return (
    <details className="setup-details restore-section">
      <summary>Restore from backup</summary>
      <p>
        Use an encrypted Sazuz snapshot and its vault passphrase or recovery key. Restoration
        replaces this fresh installation, signs out old sessions and stops historical work. Review
        automations before enabling them.
      </p>
      <form
        className="setup-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          if (!file || busy) return;
          setBusy(true);
          setMessage('Checking encrypted file…');
          const restore = async () => {
            if (file.size > MAX_BACKUP_FILE_BYTES)
              throw new Error('This backup exceeds the 128 MiB snapshot limit.');
            const bytes = new Uint8Array(await file.arrayBuffer());
            const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
              .map((value) => value.toString(16).padStart(2, '0'))
              .join('');
            // A deterministic, non-secret request ID lets reselecting the same file resume an interrupted upload.
            const requestId = `${sha256.slice(0, 8)}-${sha256.slice(8, 12)}-4${sha256.slice(13, 16)}-8${sha256.slice(17, 20)}-${sha256.slice(20, 32)}`;
            let upload = await api('setup/restore', restoreUploadSchema, {
              requestId,
              bytes: bytes.length,
              sha256,
            });
            while (upload.receivedBytes < bytes.length) {
              const offset = upload.receivedBytes,
                chunk = bytes.subarray(offset, offset + 65536);
              let binary = '';
              for (const value of chunk) binary += String.fromCharCode(value);
              upload = await api(
                `setup/restore/${upload.operation.id}/chunks`,
                restoreUploadSchema,
                { offset, data: btoa(binary) },
              );
              setMessage(
                `Uploading encrypted backup: ${Math.floor((upload.receivedBytes / bytes.length) * 100)}%`,
              );
            }
            setMessage('Verifying the archive and restoring the instance…');
            await api(`setup/restore/${upload.operation.id}/complete`, operationSchema, {
              credential,
              confirm: 'restore',
            });
            setDone(true);
            setMessage(
              'Restore completed. Sazuz is restarting. Sign in with the restored owner account; review paused work and automation settings.',
            );
          };
          void restore()
            .catch((cause) =>
              setMessage(cause instanceof Error ? cause.message : 'Restore could not complete.'),
            )
            .finally(() => {
              setCredential('');
              setBusy(false);
            });
        }}
      >
        <label className="setup-field">
          Encrypted backup file
          <input
            type="file"
            accept=".sazuz"
            required
            disabled={busy || done}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <label className="setup-field">
          Vault passphrase or recovery key
          <input
            type="password"
            autoComplete="off"
            required
            maxLength={256}
            value={credential}
            disabled={busy || done}
            onChange={(event) => setCredential(event.target.value)}
          />
        </label>
        <button disabled={busy || done || !file}>
          {busy ? 'Restoring…' : 'Restore this fresh installation'}
        </button>
      </form>
      <p role="status">{message}</p>
      {done && <a href="/login">Sign in after restart</a>}
    </details>
  );
}
