import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { settingsDocumentSchema, settingsSchemas } from '@sazuz/config/settings';
import type { Approval } from '@sazuz/core/missions';
import { api } from '../lib/api';
import { suggestRecipientRule } from '../lib/scoped-policy';
import { useWorkspaceResource, workspaceError } from '../lib/use-workspace';
import { agentLabels } from './durable-shared';

export function ScopedRuleSuggestion({
  approval,
  disabled,
}: {
  approval: Approval;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const settings = useWorkspaceResource('settings', settingsDocumentSchema, open, false);
  const client = useQueryClient();
  const suggestion = suggestRecipientRule(approval, `allow-${approval.id}`);
  async function save() {
    if (!settings.data || !suggestion) return;
    setBusy(true);
    setError('');
    try {
      const current = settings.data.security;
      if (current.value.rules.some((rule) => rule.id === suggestion.rule.id)) {
        setError('A rule for this request already exists. Review it in Safety settings.');
        return;
      }
      const value = settingsSchemas.security.parse({
        ...current.value,
        rules: [...current.value.rules, suggestion.rule],
      });
      await api(
        'settings/security',
        z.object({ version: z.number().int().positive() }),
        { value, expectedVersion: current.version },
        'PUT',
      );
      setSaved(true);
      await client.invalidateQueries({ queryKey: ['workspace', 'settings'] });
    } catch (cause) {
      setError(workspaceError(cause));
      await settings.refetch();
    } finally {
      setBusy(false);
    }
  }
  if (!suggestion)
    return (
      <p className="work-muted">
        For a scoped policy rule, use <Link href="/settings?section=security">Safety settings</Link>
        .
      </p>
    );
  return (
    <section className="scoped-rule" aria-label="Scoped allow rule">
      <button
        className="secondary"
        disabled={disabled || busy || saved}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Always allow — review scoped rule
      </button>
      {open && (
        <div className="rule-review">
          <h3>Review a scoped allow rule</h3>
          <p>
            <strong>{suggestion.summary}</strong>
          </p>
          <p>
            Applies to {agentLabels[approval.agentId]} in this project, for{' '}
            <code>{approval.toolName}</code> and exactly these To, Cc and Bcc recipients.
          </p>
          <p>
            The {settings.data?.security.value.preset ?? 'current'} preset, deny rules and required
            approvals still apply. Actions proposed after reading external content still require
            review. Saving this suggestion does not approve the current request.
          </p>
          <details>
            <summary>Exact rule</summary>
            <pre>{JSON.stringify(suggestion.rule, null, 2)}</pre>
          </details>
          {saved ? (
            <p className="setup-notice" role="status">
              Scoped rule saved in versioned Safety settings. Review the pending action separately.
            </p>
          ) : (
            <button
              disabled={disabled || busy || !settings.data || !!settings.error}
              onClick={() => {
                void save();
              }}
            >
              {busy ? 'Saving rule…' : 'Save scoped rule'}
            </button>
          )}
          {(error || settings.error) && (
            <p className="setup-error" role="alert">
              {error || workspaceError(settings.error)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
