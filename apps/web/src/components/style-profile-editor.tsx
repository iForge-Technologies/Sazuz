'use client';
import '../lib/validation';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { skillVersionSchema, styleProfileSchema } from '@sazuz/core/skills';
import { api } from '../lib/api';
import { useWorkspaceResource, useWorkspaceSession, workspaceError } from '../lib/use-workspace';
import { StyleSentSamples } from './style-sent-samples';
import { StyleComparisonPanel } from './style-comparison-panel';

const profilesSchema = z.array(styleProfileSchema);
export function StyleProfileEditor() {
  const session = useWorkspaceSession();
  const profiles = useWorkspaceResource('skills/style/profiles', profilesSchema, session.ready);
  const [samples, setSamples] = useState(''),
    [privateOnly, setPrivateOnly] = useState(true),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const requestId = useRef<string | null>(null);
  return (
    <section className="configuration-section style-editor" aria-label="Writing style">
      <h2>Writing style</h2>
      <p>
        Paste a sample you wrote to preview a style guide and example draft. Sazuz uses the Fast
        model and your spending limits. Accept a preview to apply its preferences when drafting.
      </p>
      {(error || profiles.error || session.error) && (
        <p role="alert" className="setup-error">
          {error || workspaceError(profiles.error || session.error)}
        </p>
      )}
      {notice && (
        <p role="status" className="setup-notice">
          {notice}
        </p>
      )}
      <form
        className="work-form"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          setNotice('');
          requestId.current ??= crypto.randomUUID();
          void api('skills/style/preview', styleProfileSchema, {
            requestId: requestId.current,
            samples: [samples],
            privateOnly,
          })
            .then(async (profile) => {
              requestId.current = null;
              setNotice(
                profile.errorCode === 'STYLE_BUSY'
                  ? 'Other work is in progress. Try generating the preview again shortly.'
                  : profile.status === 'preview'
                    ? 'Preview ready. Review the draft and instructions before accepting.'
                    : profile.status === 'generating'
                      ? 'The preview is still generating. Its result will appear below.'
                      : 'The preview did not finish. Check the Fast model, vault and budget before generating another.',
              );
              await profiles.refetch();
            })
            .catch((cause: unknown) => setError(workspaceError(cause)))
            .finally(() => setBusy(false));
        }}
      >
        <label className="setup-field">
          Writing sample
          <textarea
            rows={5}
            required
            minLength={20}
            maxLength={6000}
            value={samples}
            disabled={busy}
            onChange={(event) => {
              setSamples(event.target.value);
              requestId.current = null;
            }}
          />
        </label>
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
          Use local models for these samples and the resulting skill
        </label>
        <button disabled={busy || !session.ready || samples.trim().length < 20}>
          {busy ? 'Generating…' : 'Generate style preview'}
        </button>
      </form>
      <StyleSentSamples
        ready={session.ready}
        onPreview={async () => {
          await profiles.refetch();
        }}
      />
      {profiles.data?.map((profile) => (
        <article key={profile.id} className="style-preview" aria-label="Style preview">
          <p>
            <strong>{profile.status}</strong> · ${profile.costUsd.toFixed(4)}
            {profile.revision ? ` · accepted revision ${profile.revision}` : ''}
          </p>
          {profile.sources.length > 0 && (
            <details>
              <summary>{profile.sources.length} consented sent-message samples</summary>
              <ul>
                {profile.sources.map((source) => (
                  <li key={source.callId}>
                    <a href={`/missions/${source.missionId}`}>Source mission</a> · {source.tool} ·{' '}
                    {source.characters} characters
                  </li>
                ))}
              </ul>
            </details>
          )}
          {profile.errorCode === 'STYLE_BUSY' ? (
            <p>
              No model call was made for this preview. Wait for the other work to finish, then
              generate a new preview.
            </p>
          ) : (
            profile.errorCode && (
              <p>
                {profile.errorCode}: configure the Fast model in{' '}
                <a href="/settings?section=models">Settings</a> and generate a new preview.
                Interrupted calls may have incurred a charge.
              </p>
            )
          )}
          {profile.sampleDraft && (
            <>
              <h3>Example draft</h3>
              <p className="message-content">{profile.sampleDraft}</p>
            </>
          )}
          {profile.markdown && (
            <details>
              <summary>Style instructions</summary>
              <pre className="message-content">{profile.markdown}</pre>
            </details>
          )}
          {profile.status === 'preview' && (
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError('');
                void api(`skills/style/${profile.id}/accept`, skillVersionSchema, {})
                  .then(async () => {
                    await profiles.refetch();
                    setNotice(
                      'Style accepted. Its current enabled revision will be used when drafting.',
                    );
                  })
                  .catch((cause: unknown) => setError(workspaceError(cause)))
                  .finally(() => setBusy(false));
              }}
            >
              Accept writing style
            </button>
          )}
        </article>
      ))}
      <StyleComparisonPanel ready={session.ready} />
    </section>
  );
}
