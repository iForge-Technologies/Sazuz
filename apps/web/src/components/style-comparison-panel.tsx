'use client';
import '../lib/validation';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { projectSchema } from '@sazuz/core/work';
import { styleComparisonSchema, type StyleComparison } from '@sazuz/core/style';
import { api } from '../lib/api';
import { useWorkspaceResource, workspaceError } from '../lib/use-workspace';

const projectsSchema = z.array(projectSchema),
  comparisonsSchema = z.array(styleComparisonSchema);
export function StyleComparisonPanel({ ready }: { ready: boolean }) {
  const projects = useWorkspaceResource('projects', projectsSchema, ready, false);
  const [projectId, setProjectId] = useState(''),
    [task, setTask] = useState(''),
    [privateOnly, setPrivateOnly] = useState(true);
  const selectedProject = projectId || projects.data?.[0]?.id || '';
  const comparisons = useWorkspaceResource(
    `skills/style/comparisons?projectId=${selectedProject}`,
    comparisonsSchema,
    ready && !!selectedProject,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const requestId = useRef<string | null>(null);
  return (
    <section className="style-section" aria-label="Blind writing comparison">
      <h3>Compare your writing style</h3>
      <p>
        Accept a style preview, then give both drafts the same task. Choose A, B or a tie before
        seeing which used your style. Each comparison uses two draft requests within your budget, up
        to $0.20 total.
      </p>
      {(error || comparisons.error || projects.error) && (
        <p role="alert">{error || workspaceError(comparisons.error || projects.error)}</p>
      )}
      {notice && <p role="status">{notice}</p>}
      <form
        className="work-form"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          requestId.current ??= crypto.randomUUID();
          void api('skills/style/comparisons', styleComparisonSchema, {
            projectId: selectedProject,
            requestId: requestId.current,
            task,
            privateOnly,
          })
            .then(async (result) => {
              await comparisons.refetch();
              setNotice(
                result.status === 'ready'
                  ? 'Both drafts are ready. Choose before revealing the style assignment.'
                  : `Comparison ${result.status}. Its receipt and cost are saved below.`,
              );
            })
            .catch((cause: unknown) => setError(workspaceError(cause)))
            .finally(() => setBusy(false));
        }}
      >
        <label className="setup-field">
          Comparison project
          <select
            value={selectedProject}
            disabled={busy}
            onChange={(event) => {
              setProjectId(event.target.value);
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
        <label className="setup-field">
          Drafting task
          <textarea
            rows={4}
            minLength={20}
            maxLength={4000}
            required
            value={task}
            disabled={busy}
            onChange={(event) => {
              setTask(event.target.value);
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
          Use local models for both drafts
        </label>
        <button disabled={busy || !ready || !selectedProject || task.trim().length < 20}>
          {busy ? 'Drafting…' : 'Compare drafts'}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            requestId.current = null;
            setNotice('The next comparison will make two new draft requests.');
          }}
        >
          New comparison
        </button>
      </form>
      {comparisons.data?.map((comparison) => (
        <Comparison
          key={comparison.id}
          value={comparison}
          refresh={async () => {
            await comparisons.refetch();
          }}
        />
      ))}
    </section>
  );
}
function Comparison({ value, refresh }: { value: StyleComparison; refresh: () => Promise<void> }) {
  const [vote, setVote] = useState<'A' | 'B' | 'tie' | ''>(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <article className="style-comparison" aria-label="Draft comparison">
      <p>
        <strong>{value.task}</strong>
      </p>
      <p>
        {value.status} · ${value.costUsd.toFixed(4)}
      </p>
      {value.status === 'generating' && (
        <p>Waiting for both drafts. Refreshing this page does not generate again.</p>
      )}
      {value.errorCode && (
        <p>
          {value.errorCode}. Partial drafts stay hidden. Check the model and budget, then choose New
          comparison to try again. Recorded costs are retained.
        </p>
      )}
      {value.drafts && (
        <div className="style-draft-pair">
          {(['A', 'B'] as const).map((label) => (
            <section key={label} aria-label={`Draft ${label}`}>
              <h4>Draft {label}</h4>
              <p className="message-content">{value.drafts![label]}</p>
            </section>
          ))}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {value.status === 'ready' && (
        <form
          className="work-form"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            void api(`skills/style/comparisons/${value.id}/vote`, styleComparisonSchema, { vote })
              .then(refresh)
              .catch((cause: unknown) => setError(workspaceError(cause)))
              .finally(() => setBusy(false));
          }}
        >
          <fieldset className="style-vote-options" disabled={busy}>
            <legend>Which draft do you prefer?</legend>
            {(['A', 'B', 'tie'] as const).map((choice) => (
              <label key={choice}>
                <input
                  type="radio"
                  name={`vote-${value.id}`}
                  value={choice}
                  checked={vote === choice}
                  onChange={() => setVote(choice)}
                />{' '}
                {choice === 'tie' ? 'Tie' : `Prefer ${choice}`}{' '}
              </label>
            ))}
          </fieldset>
          <button disabled={busy || !vote}>Save preference and reveal</button>
        </form>
      )}
      {value.reveal && (
        <p role="status">
          Draft {value.reveal.styledLabel} used writing-style revision {value.reveal.revision}.{' '}
          {value.reveal.preference === 'tie'
            ? 'You recorded a tie.'
            : `You preferred the ${value.reveal.preference} draft.`}
        </p>
      )}
    </article>
  );
}
