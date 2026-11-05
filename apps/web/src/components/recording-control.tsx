'use client';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { recordingSchema, type Recording } from '@sazuz/core/learning';
import { api } from '../lib/api';
import { workspaceError } from '../lib/use-workspace';

export function RecordingControl({
  sessionId,
  version,
  canInput,
}: {
  sessionId: string;
  version: number;
  canInput: boolean;
}) {
  const [record, setRecord] = useState<Recording | null>(null);
  const [name, setName] = useState('Browser procedure');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const request = useRef<string | null>(null);
  async function control(stop: boolean) {
    setBusy(true);
    setError('');
    try {
      request.current ??= crypto.randomUUID();
      const value = await api(
        `browser/sessions/${sessionId}/recording`,
        recordingSchema,
        stop && record
          ? { action: 'stop', recordingId: record.id, version: record.version }
          : { action: 'start', requestId: request.current, version, name, privateOnly: true },
      );
      setRecord(value);
      if (stop) request.current = null;
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="browser-recording" aria-label="Recording controls">
      <h3>Teach a browser task</h3>
      <p>
        Take control, then record the task. Typed values become parameters. Login, verification and
        payment fields are excluded.
      </p>
      <label className="setup-field">
        Recording name
        <input
          value={name}
          maxLength={80}
          disabled={busy || record?.status === 'recording'}
          onChange={(event) => {
            setName(event.target.value);
            request.current = null;
          }}
        />
      </label>
      <div className="knowledge-actions" role="group" aria-label="Recording actions">
        <button
          disabled={busy || !canInput || !name.trim() || record?.status === 'recording'}
          onClick={() => void control(false)}
        >
          Record task
        </button>
        <button
          className="secondary"
          disabled={busy || record?.status !== 'recording'}
          onClick={() => void control(true)}
        >
          Stop recording
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            void api('skills/recordings', z.array(recordingSchema))
              .then((values) =>
                setRecord(
                  values.find(
                    (value) => value.sessionId === sessionId && value.status === 'recording',
                  ) ?? null,
                ),
              )
              .catch((cause: unknown) => setError(workspaceError(cause)));
          }}
        >
          Recover recording status
        </button>
      </div>
      {record && (
        <p role="status">
          {record.status === 'recording'
            ? 'Recording. Stop before handing back control.'
            : `Recording saved with ${record.events.filter((event) => event.replay).length} actions. ${record.omitted} sensitive or unsupported inputs excluded.`}{' '}
          {record.status !== 'recording' && <a href="/skills">Review in Skills</a>}
        </p>
      )}
      {error && (
        <p role="alert" className="setup-error">
          {error}
        </p>
      )}
    </section>
  );
}
