'use client';
import { useCallback, useEffect, useState } from 'react';
import { updateStatusSchema } from '@sazuz/core/operations';
import type { z } from 'zod';
import { api } from '../lib/api';

export function UpdateStatus() {
  const [state, setState] = useState<z.infer<typeof updateStatusSchema> | null>(null);
  const [message, setMessage] = useState('');
  const refresh = useCallback(
    () =>
      api('operations/updates', updateStatusSchema.nullable())
        .then(setState)
        .catch(() => setMessage('Update status could not be loaded.')),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <section className="configuration-section update-section" aria-label="Updates">
      <h2>Updates</h2>
      <p>
        Use <code>sazuz update release.json</code> on this host with a reviewed release manifest. An
        encrypted backup is made before the new image is pulled. Keep the recovery kit for that
        backup.
      </p>
      <button
        className="secondary"
        onClick={() => {
          void refresh();
        }}
      >
        Refresh update status
      </button>
      <p role="status">{message}</p>
      {state ? (
        <>
          <p>
            Version {state.release.version}: <strong>{state.stage.replaceAll('-', ' ')}</strong>
          </p>
          <p>
            Started {new Date(state.startedAt).toLocaleString()}
            {state.finishedAt ? `; finished ${new Date(state.finishedAt).toLocaleString()}` : ''}.
          </p>
          {state.backupId && (
            <p>
              <a href={`/api/backups/${state.backupId}/download`}>Download the pre-update backup</a>
            </p>
          )}
          <details className="setup-details">
            <summary>Release notes</summary>
            <p className="release-notes">{state.release.notes}</p>
          </details>
          {!['done', 'rolled-back', 'aborted'].includes(state.stage) && (
            <p>
              An update is pending. Use <code>sazuz update recover</code> on the host if its command
              was interrupted.
            </p>
          )}
          {state.stage === 'rolled-back' && (
            <p>
              The previous image and snapshot were restored. Historical work is stopped; review
              external effects and automations before resuming.
            </p>
          )}
        </>
      ) : (
        <p>No update has been recorded.</p>
      )}
    </section>
  );
}
