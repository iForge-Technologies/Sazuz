'use client';
import '../lib/validation';
import { useState } from 'react';
import { Icon } from './icons';
import { useQueryClient } from '@tanstack/react-query';
import { controlInputSchema, controlSchema } from '@sazuz/core/missions';
import { api } from '../lib/api';
import { useWorkspaceResource, useWorkspaceSession, workspaceError } from '../lib/use-workspace';

export function WorkControl() {
  const session = useWorkspaceSession();
  const control = useWorkspaceResource('control', controlSchema, session.ready);
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function change() {
    if (!control.data || busy) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api(
        'control',
        controlSchema,
        controlInputSchema.parse({ paused: !control.data.paused, version: control.data.version }),
      );
      client.setQueryData(['workspace', 'control'], updated);
      await client.invalidateQueries({ queryKey: ['workspace'] });
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  if (!session.ready) return null;
  return (
    <div className="work-control">
      <button
        type="button"
        className="secondary pause-control"
        disabled={busy || !control.data || !!control.error}
        onClick={() => {
          void change();
        }}
      >
        <Icon name={control.data?.paused ? 'play' : 'pause'} />
        {busy ? 'Updating…' : control.data?.paused ? 'Resume all agents' : 'Pause all agents'}
      </button>
      {control.data?.paused && (
        <span role="status" className="work-tag">
          All agents paused
        </span>
      )}
      {(error || control.error) && (
        <p role="alert">{error || 'Pause controls are unavailable. Refresh the page.'}</p>
      )}
    </div>
  );
}
