'use client';
import { useState } from 'react';
import { z } from 'zod';
import { workflowDraftSchema, type WorkflowDefinition } from '@sazuz/core/workflows';
import { api } from '../lib/api';
import { useWorkspaceResource, workspaceError } from '../lib/use-workspace';

export function WorkflowDraftComposer({
  projectId,
  apply,
}: {
  projectId: string;
  apply: (definition: WorkflowDefinition) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [privateOnly, setPrivateOnly] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const receipts = useWorkspaceResource(
    `workflows/drafts?projectId=${projectId}`,
    z.array(workflowDraftSchema),
    true,
    false,
  );
  return (
    <section className="durable-card operation-section" id="workflow-describe">
      <h2>Describe a workflow</h2>
      <p>
        The Planner prepares an editable graph. Inspect its steps, save a revision, then review it
        before running or enabling its trigger. Generation uses at most $0.25 from your configured
        budget.
      </p>
      <label className="setup-field">
        Workflow request
        <textarea
          rows={3}
          maxLength={4000}
          value={prompt}
          disabled={busy || !!requestId}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Every Monday, read GitHub issues labelled bug, summarize them and notify me."
        />
      </label>
      <label className="setup-check">
        <input
          type="checkbox"
          checked={privateOnly}
          disabled={busy || !!requestId}
          onChange={(event) => setPrivateOnly(event.target.checked)}
        />
        Use private models only
      </label>
      <div className="durable-actions">
        <button
          disabled={busy || prompt.trim().length < 10}
          onClick={() =>
            void (async () => {
              const id = requestId ?? crypto.randomUUID();
              setRequestId(id);
              setBusy(true);
              setError('');
              try {
                await api('workflows/drafts', workflowDraftSchema, {
                  projectId,
                  requestId: id,
                  prompt,
                  privateOnly,
                });
                await receipts.refetch();
              } catch (cause) {
                setError(workspaceError(cause));
              } finally {
                setBusy(false);
              }
            })()
          }
        >
          {busy ? 'Drafting…' : requestId ? 'Retrieve this request' : 'Generate draft'}
        </button>
        {requestId && (
          <button
            disabled={busy}
            onClick={() => {
              setRequestId(null);
              setError('');
            }}
          >
            Start a new request
          </button>
        )}
        <button disabled={busy} onClick={() => void receipts.refetch()}>
          Refresh receipts
        </button>
      </div>
      {(error || receipts.error) && (
        <p role="alert" className="setup-error">
          {error || workspaceError(receipts.error)}
        </p>
      )}
      <ul>
        {receipts.data?.map((receipt) => (
          <li key={receipt.id}>
            {receipt.definition?.name ?? 'Workflow request'} · {receipt.status} · $
            {receipt.costUsd.toFixed(4)}
            {receipt.status === 'failed' && (
              <p>
                Generation stopped ({receipt.errorCode}). This request will not run again. Inspect
                the charge before starting a new request.
              </p>
            )}
            {receipt.status === 'generating' && (
              <p>Generation is pending. Refresh to retrieve its receipt.</p>
            )}
            {receipt.definition && (
              <>
                <details>
                  <summary>Inspect generated graph</summary>
                  <pre>{JSON.stringify(receipt.definition, null, 2)}</pre>
                </details>
                <button onClick={() => apply(receipt.definition!)}>Apply to editor</button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
