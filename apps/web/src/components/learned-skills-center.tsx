'use client';
import '../lib/validation';
import { useRef, useState } from 'react';
import { z } from 'zod';
import {
  recordingSchema,
  loopCandidateSchema,
  learnedDraftSchema,
  learnedProgramSchema,
  learnedVersionSchema,
  type LearnedDraft,
  type Recording,
} from '@sazuz/core/learning';
import { api } from '../lib/api';
import { useWorkspaceResource, workspaceError } from '../lib/use-workspace';

const recordingList = z.array(recordingSchema),
  draftList = z.array(learnedDraftSchema);
const analysisSchema = z.strictObject({
  recording: recordingSchema,
  loops: z.array(loopCandidateSchema),
});
export function LearnedSkillsCenter({
  ready,
  onSaved,
}: {
  ready: boolean;
  onSaved: () => Promise<unknown>;
}) {
  const recordings = useWorkspaceResource('skills/recordings', recordingList, ready);
  const drafts = useWorkspaceResource('skills/learned/drafts', draftList, ready);
  const [record, setRecord] = useState<Recording | null>(null);
  const [loops, setLoops] = useState<z.infer<typeof loopCandidateSchema>[]>([]),
    [loopIndex, setLoopIndex] = useState(-1);
  const [parameters, setParameters] = useState<Record<string, string>>({}),
    [name, setName] = useState('learned-browser-task');
  const [draft, setDraft] = useState<LearnedDraft | null>(null),
    [program, setProgram] = useState(''),
    [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const requestId = useRef<string | null>(null);
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  function edit(value: LearnedDraft) {
    setDraft(value);
    setProgram(value.program ? JSON.stringify(value.program, null, 2) : '');
    setDescription(value.description ?? '');
  }
  return (
    <section
      className="durable-card operation-section"
      aria-label="Learned browser skills"
      id="learned-skills"
    >
      <h2>Teach by watching</h2>
      <p>
        <a href="/browser">Record a task in the live browser</a>, name its inputs, then review the
        generated steps. Recorded text is page evidence; every live action still follows your
        policy.
      </p>
      {(error || recordings.error || drafts.error) && (
        <p role="alert" className="setup-error">
          {error || workspaceError(recordings.error || drafts.error)}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button
        className="secondary"
        disabled={busy}
        onClick={() =>
          void act(async () => {
            await recordings.refetch();
            await drafts.refetch();
          })
        }
      >
        Refresh recordings and drafts
      </button>
      <ul>
        {recordings.data?.map((item) => (
          <li key={item.id}>
            <button
              className="secondary"
              disabled={busy || item.status !== 'stopped'}
              onClick={() =>
                void act(async () => {
                  const analysis = await api(`skills/recordings/${item.id}`, analysisSchema);
                  setRecord(analysis.recording);
                  setLoops(analysis.loops);
                  setLoopIndex(-1);
                  setParameters({});
                  setDraft(null);
                  requestId.current = null;
                })
              }
            >
              {item.name}
            </button>{' '}
            · {item.status} · {item.events.filter((event) => event.replay).length} actions ·{' '}
            {item.omitted} excluded
          </li>
        ))}
      </ul>
      {record && (
        <form
          className="work-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              requestId.current ??= crypto.randomUUID();
              const selected = loops[loopIndex];
              const value = await api(
                `skills/recordings/${record.id}/generate`,
                learnedDraftSchema,
                {
                  requestId: requestId.current,
                  name,
                  parameters,
                  loops: selected ? [{ ...selected, parameter: 'items' }] : [],
                },
              );
              edit(value);
              await drafts.refetch();
              setNotice(
                value.status === 'ready'
                  ? 'Draft ready. Review all parameters, targets and steps before saving.'
                  : `Generation ${value.status}. ${value.errorCode ?? 'Refresh to see its result.'}`,
              );
            });
          }}
        >
          <h3>{record.name}</h3>
          <label className="setup-field">
            Learned skill name
            <input
              value={name}
              required
              pattern="[a-z][a-z0-9-]*"
              maxLength={64}
              disabled={busy}
              onChange={(event) => {
                setName(event.target.value);
                requestId.current = null;
              }}
            />
          </label>
          {record.events
            .filter((event) => event.replay)
            .map((event, index) => (
              <div key={event.id}>
                <p>
                  {index + 1}. {event.kind} {event.target?.name ?? event.url}
                </p>
                {['fill', 'select'].includes(event.kind) && (
                  <label className="setup-field">
                    Parameter for {event.target?.name || event.id}
                    <input
                      value={parameters[event.id] ?? `value${index + 1}`}
                      required
                      pattern="[a-z][a-z0-9_]*"
                      maxLength={40}
                      disabled={busy}
                      onChange={(change) => {
                        setParameters({ ...parameters, [event.id]: change.target.value });
                        requestId.current = null;
                      }}
                    />
                  </label>
                )}
              </div>
            ))}
          {!!loops.length && (
            <label className="setup-field">
              Repeated list pattern
              <select
                value={loopIndex}
                disabled={busy}
                onChange={(event) => {
                  setLoopIndex(Number(event.target.value));
                  requestId.current = null;
                }}
              >
                <option value={-1}>Keep individual actions</option>
                {loops.map((loop, index) => (
                  <option key={index} value={index}>
                    Actions {loop.start + 1}–{loop.start + loop.length}, repeated {loop.repeats}{' '}
                    times → items list
                  </option>
                ))}
              </select>
            </label>
          )}
          <p>
            Recording values and image crops are excluded. Generation uses the Planner and the
            recording’s privacy setting.
          </p>
          <button disabled={busy || !ready}>Generate learned skill</button>
        </form>
      )}
      <h3>Generated drafts</h3>
      <ul>
        {drafts.data?.map((item) => (
          <li key={item.id}>
            <button
              className="secondary"
              disabled={busy || !item.program}
              onClick={() => edit(item)}
            >
              {item.name}
            </button>{' '}
            · {item.status} · ${item.costUsd.toFixed(4)} {item.errorCode}
          </li>
        ))}
      </ul>
      {draft?.program && (
        <form
          className="work-form"
          aria-label="Learned program editor"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const saved = await api('skills/learned', learnedVersionSchema, {
                draftId: draft.id,
                expectedRevision: 0,
                description,
                program: learnedProgramSchema.parse(JSON.parse(program)),
                enabled: true,
              });
              setNotice(
                `Reviewed ${saved.skill.name} revision ${saved.skill.revision}. No run has started.`,
              );
              await drafts.refetch();
              await onSaved();
              setDraft({
                ...draft,
                status: 'saved',
                skillId: saved.skill.id,
                revision: saved.skill.revision,
              });
            });
          }}
        >
          <label className="setup-field">
            Skill description
            <input
              value={description}
              required
              maxLength={240}
              disabled={busy || draft.status === 'saved'}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="setup-field">
            Reviewed steps and locators
            <textarea
              rows={18}
              value={program}
              disabled={busy || draft.status === 'saved'}
              spellCheck={false}
              onChange={(event) => setProgram(event.target.value)}
            />
          </label>
          <details>
            <summary>Generated SKILL.md</summary>
            <pre className="message-content">{draft.markdown}</pre>
          </details>
          <details>
            <summary>Playwright script for review</summary>
            <pre className="message-content">{draft.script}</pre>
          </details>
          <button disabled={busy || draft.status !== 'ready'}>Review and save learned skill</button>
        </form>
      )}
    </section>
  );
}
