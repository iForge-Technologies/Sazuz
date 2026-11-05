'use client';
import { useEffect, useState } from 'react';
import { setupStatusSchema } from '@sazuz/config/contracts';
import { api } from '../lib/api';
import { Icon } from './icons';
export function WorkspaceEntry() {
  const [complete, setComplete] = useState<boolean | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    void api('setup/status', setupStatusSchema)
      .then((status) => setComplete(status.completed))
      .catch(() => setUnavailable(true));
  }, []);
  return (
    <nav className="workspace-entry" aria-label="Workspace">
      <div className="workspace-entry-heading">
        <p className="eyebrow">WELCOME TO SAZUZ</p>
        <strong>Your workspace, ready when you are.</strong>
        <span>Conversations, autonomous work and the controls to review it.</span>
      </div>
      <div className="workspace-entry-links">
        {complete === false ? (
          <a href="/setup">Continue setup →</a>
        ) : (
          <>
            <a href="/chat">Open chat →</a>
            <a href="/missions">Missions</a>
            <a href="/approvals">Approvals</a>
            <a href="/automations">Automations</a>
            <a href="/models">Models</a>
            <a href="/settings">Open Settings Center →</a>
            <a href="/login">Sign in</a>
          </>
        )}
      </div>
      {complete && (
        <span className="workspace-entry-note">
          <Icon name="approvals" />
          Start a project conversation, review your model connections, or adjust workspace settings.
        </span>
      )}
      {unavailable && (
        <span role="status">
          Setup status is unavailable. Open System health below to check your instance.
        </span>
      )}
    </nav>
  );
}
