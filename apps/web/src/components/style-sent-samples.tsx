'use client';
import '../lib/validation';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { projectSchema } from '@sazuz/core/work';
import { styleProfileSchema } from '@sazuz/core/skills';
import { styleSentSourceSchema } from '@sazuz/core/style';
import { api } from '../lib/api';
import { useWorkspaceResource, workspaceError } from '../lib/use-workspace';

const projectsSchema = z.array(projectSchema),
  sourcesSchema = z.array(styleSentSourceSchema);
export function StyleSentSamples({
  ready,
  onPreview,
}: {
  ready: boolean;
  onPreview: () => Promise<void>;
}) {
  const projects = useWorkspaceResource('projects', projectsSchema, ready, false);
  const [projectId, setProjectId] = useState('');
  const selectedProject = projectId || projects.data?.[0]?.id || '';
  const sources = useWorkspaceResource(
    `skills/style/sources?projectId=${selectedProject}`,
    sourcesSchema,
    ready && !!selectedProject,
  );
  const [selected, setSelected] = useState<string[]>([]),
    [consent, setConsent] = useState(false),
    [privateOnly, setPrivateOnly] = useState(true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const requestId = useRef<string | null>(null);
  return (
    <section className="style-section" aria-label="Sent-message style samples">
      <h3>Learn from selected sent messages</h3>
      <p>
        Select up to three confirmed messages sent through Sazuz. Only the selected text is used, up
        to 6,000 characters each and 12,000 total. You can also paste a sent-mail export in the
        sample field above.
      </p>
      {(error || projects.error || sources.error) && (
        <p role="alert">{error || workspaceError(projects.error || sources.error)}</p>
      )}
      {notice && <p role="status">{notice}</p>}
      <form
        className="work-form"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          requestId.current ??= crypto.randomUUID();
          void api('skills/style/sent-preview', styleProfileSchema, {
            projectId: selectedProject,
            requestId: requestId.current,
            callIds: selected,
            consent,
            privateOnly,
          })
            .then(async (profile) => {
              await onPreview();
              setNotice(
                profile.status === 'preview'
                  ? 'Preview ready below. Review it before accepting.'
                  : `Preview ${profile.status}. Review its status and recorded cost below.`,
              );
            })
            .catch((cause: unknown) => setError(workspaceError(cause)))
            .finally(() => setBusy(false));
        }}
      >
        <label className="setup-field">
          Sample project
          <select
            value={selectedProject}
            disabled={busy}
            onChange={(event) => {
              setProjectId(event.target.value);
              setSelected([]);
              setConsent(false);
              requestId.current = null;
            }}
          >
            {projects.data?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="setup-group style-source-list" disabled={busy}>
          <legend>Confirmed sent messages</legend>
          {sources.data?.length === 0 && (
            <p>
              No eligible receipts in this project's latest 50 sends. Pasted exports are available
              above.
            </p>
          )}
          {sources.data?.map((source) => (
            <label key={source.callId} className="setup-field style-source">
              <span>
                <input
                  type="checkbox"
                  checked={selected.includes(source.callId)}
                  disabled={!selected.includes(source.callId) && selected.length >= 3}
                  onChange={(event) => {
                    setSelected((prior) =>
                      event.target.checked
                        ? [...prior, source.callId]
                        : prior.filter((id) => id !== source.callId),
                    );
                    setConsent(false);
                    requestId.current = null;
                  }}
                />{' '}
                {source.subject || 'Message without a subject'}
              </span>
              <small>
                {source.tool} · {new Date(source.sentAt).toLocaleString()} · up to{' '}
                {source.characters} characters{source.privateOnly ? ' · local models required' : ''}
              </small>
            </label>
          ))}
        </fieldset>
        <label className="setup-check">
          <input
            type="checkbox"
            checked={privateOnly}
            disabled={busy}
            onChange={(event) => {
              setPrivateOnly(event.target.checked);
              requestId.current = null;
            }}
          />{' '}
          Use local models for these samples and their style
        </label>
        <label className="setup-check">
          <input
            type="checkbox"
            checked={consent}
            disabled={busy}
            onChange={(event) => setConsent(event.target.checked)}
          />{' '}
          I consent to using the selected messages as samples of my writing.
        </label>
        <button disabled={busy || !ready || !selectedProject || !selected.length || !consent}>
          {busy ? 'Generating…' : 'Preview selected messages'}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            requestId.current = null;
            setNotice('The next preview will make a new model request.');
          }}
        >
          New sample preview
        </button>
      </form>
    </section>
  );
}
