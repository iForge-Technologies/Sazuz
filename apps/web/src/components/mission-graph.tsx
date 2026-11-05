'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { GraphView, blackboardEntrySchema } from '@sazuz/core/graphs';
import { runSchema, type Run, type RunControl } from '@sazuz/core/missions';
import { api } from '../lib/api';
import { useWorkspaceResource, workspaceError } from '../lib/use-workspace';
import { agentLabels, LocalTime, RequestNotice } from './durable-shared';
import { formatCost } from './chat-messages';
import { MissionControls } from './mission-controls';
import { CitedText } from './cited-text';

const Diagram = dynamic(() => import('./mission-diagram'), {
  ssr: false,
  loading: () => <p role="status">Loading task graph…</p>,
});
export function MissionReply({ run }: { run: Run }) {
  const client = useQueryClient();
  const [text, setText] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <form
      className="work-form"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        void api(
          `missions/${run.missionId}/messages`,
          z.strictObject({ recorded: z.literal(true) }),
          { runId: run.id, version: run.version, text, requestId: crypto.randomUUID() },
        )
          .then(async () => {
            setText('');
            await client.invalidateQueries({ queryKey: ['workspace'] });
          })
          .catch((cause: unknown) => setError(workspaceError(cause)))
          .finally(() => setBusy(false));
      }}
    >
      <label className="setup-field">
        Reply to the team
        <textarea
          required
          maxLength={8000}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <button disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Reply and continue'}</button>
      <RequestNotice message={error} />
    </form>
  );
}
function TaskRun({ id, globallyPaused }: { id: string; globallyPaused: boolean }) {
  const resource = useWorkspaceResource(`runs/${id}`, runSchema, true);
  const client = useQueryClient();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function control(input: RunControl) {
    setBusy(true);
    setError('');
    try {
      await api(`runs/${id}/control`, runSchema, input);
      await client.invalidateQueries({ queryKey: ['workspace'] });
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <RequestNotice error={resource.error} message={error} />
      {resource.data && (
        <>
          <MissionControls
            noun="task"
            run={resource.data}
            disabled={busy}
            globallyPaused={globallyPaused}
            onControl={control}
          />
          {resource.data.status === 'paused' && !globallyPaused && (
            <MissionReply run={resource.data} />
          )}
        </>
      )}
    </>
  );
}
export function MissionGraph({
  graph,
  globallyPaused,
}: {
  graph: GraphView;
  globallyPaused: boolean;
}) {
  const [selected, setSelected] = useState(graph.tasks[0]?.key ?? '');
  const task = graph.tasks.find((item) => item.key === selected) ?? graph.tasks[0];
  return (
    <section className="mission-graph" aria-label="Mission graph and tasks">
      <header className="durable-heading">
        <h3>Task graph</h3>
        <span className="work-tag">Revision {graph.revision}</span>
      </header>
      <p>{graph.plan.deliverable}</p>
      <Diagram graph={graph} selected={task?.key ?? ''} select={setSelected} />
      <ol className="mission-task-list" aria-label="Task list">
        {graph.tasks.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              className="secondary"
              aria-pressed={item.key === task?.key}
              onClick={() => setSelected(item.key)}
            >
              <strong>
                {item.key} · {agentLabels[item.definition.agent]}
              </strong>
              <span>
                {item.status.replaceAll('_', ' ')} · {item.steps} steps · {formatCost(item.costUsd)}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {task && (
        <article className="task-detail" aria-label={`Task ${task.key} details`}>
          <h4>
            {task.key}: {task.definition.goal}
          </h4>
          <p className="work-muted">
            {task.definition.depends_on.length
              ? `Waits for ${task.definition.depends_on.join(', ')}`
              : 'Independent task'}{' '}
            · Attempt {task.attempt || 1} of 3
          </p>
          <h5>Acceptance criteria</h5>
          <ul>
            {task.definition.acceptance.map((criterion, index) => (
              <li key={index}>{criterion}</li>
            ))}
          </ul>
          <p>
            Task allowance: {task.definition.budget.steps} steps and{' '}
            {formatCost(task.definition.budget.usd)}, shared across attempts.
          </p>
          {task.feedback && <p className="setup-notice">{task.feedback}</p>}
          {task.result && (
            <p className="message-content">
              <CitedText text={task.result.text} />
            </p>
          )}
          {task.runId && (
            <TaskRun key={task.runId} id={task.runId} globallyPaused={globallyPaused} />
          )}
        </article>
      )}
      <details className="tool-observation">
        <summary>Plan revisions ({graph.revisions.length})</summary>
        <ol>
          {graph.revisions.map((revision) => (
            <li key={revision.revision}>
              Revision {revision.revision}: {revision.reason}{' '}
              <LocalTime value={revision.createdAt} />
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
export function MissionBlackboard({ notes }: { notes: z.infer<typeof blackboardEntrySchema>[] }) {
  return (
    <section className="mission-blackboard" aria-label="Shared mission notes">
      <h3>Shared notes</h3>
      {notes.length ? (
        <ol>
          {notes.map((note) => (
            <li key={note.id}>
              <header>
                <strong>{note.agentId === 'user' ? 'You' : agentLabels[note.agentId]}</strong>{' '}
                <LocalTime value={note.createdAt} />
              </header>
              <p className="message-content">
                <CitedText text={note.text} />
              </p>
              {note.artifacts.length > 0 && <p>Artifacts: {note.artifacts.join(', ')}</p>}
            </li>
          ))}
        </ol>
      ) : (
        <p className="work-muted">
          Notes and artifact references shared by the team will appear here.
        </p>
      )}
    </section>
  );
}
