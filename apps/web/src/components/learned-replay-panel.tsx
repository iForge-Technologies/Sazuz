'use client';
import '../lib/validation';
import { useRef, useState } from 'react';
import { z } from 'zod';
import {
  learnedProgramSchema,
  learnedVersionSchema,
  type LearnedVersion,
} from '@sazuz/core/learning';
import {
  learnedInputsSchema,
  learnedReplaySchema,
  learnedRepairSchema,
} from '@sazuz/core/learning-replay';
import { browserProfileSchema } from '@sazuz/core/browser';
import { api } from '../lib/api';
import { useWorkspaceResource, workspaceError } from '../lib/use-workspace';

const profilesSchema = z.array(browserProfileSchema),
  historySchema = z.array(learnedReplaySchema),
  repairsSchema = z.array(learnedRepairSchema);
function sampleInputs(value: LearnedVersion) {
  const inputs: Record<string, string | Record<string, string>[]> = {};
  for (const node of value.program.steps) {
    if (node.kind === 'action') {
      if (node.parameter) inputs[node.parameter] = '';
    } else
      inputs[node.parameter] = [
        Object.fromEntries(
          node.steps.filter((step) => step.parameter).map((step) => [step.parameter!, '']),
        ),
      ];
  }
  return JSON.stringify(inputs, null, 2);
}
export function LearnedReplayPanel({
  skillId,
  revision,
  onSaved,
}: {
  skillId: string;
  revision: number;
  onSaved: () => Promise<void>;
}) {
  const resource = useWorkspaceResource(
    `skills/learned/${skillId}?revision=${revision}`,
    learnedVersionSchema,
    true,
    false,
  );
  if (resource.error) return <p role="alert">{workspaceError(resource.error)}</p>;
  return resource.data ? (
    <ReplayEditor key={`${skillId}:${revision}`} initial={resource.data} onSaved={onSaved} />
  ) : (
    <p>Loading learned program…</p>
  );
}
function ReplayEditor({
  initial,
  onSaved,
}: {
  initial: LearnedVersion;
  onSaved: () => Promise<void>;
}) {
  const path = `skills/learned/${initial.skill.id}`;
  const profiles = useWorkspaceResource('browser/profiles', profilesSchema, true);
  const history = useWorkspaceResource(`${path}/replays`, historySchema, true);
  const repairs = useWorkspaceResource(`${path}/repairs`, repairsSchema, true);
  const [inputs, setInputs] = useState(() => sampleInputs(initial));
  const [profileId, setProfileId] = useState(''),
    [allowRepair, setAllowRepair] = useState(true);
  const [program, setProgram] = useState(JSON.stringify(initial.program, null, 2));
  const [description, setDescription] = useState(initial.skill.description),
    [enabled, setEnabled] = useState(initial.skill.enabled);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const requests = useRef<Partial<Record<'live' | 'rehearsal', string>>>({});
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
  async function run(mode: 'live' | 'rehearsal') {
    requests.current[mode] ??= crypto.randomUUID();
    const value = await api(`${path}/replays`, learnedReplaySchema, {
      requestId: requests.current[mode],
      revision: initial.skill.revision,
      inputs: learnedInputsSchema.parse(JSON.parse(inputs)),
      mode,
      allowRepair,
      ...(mode === 'live' ? { profileId } : {}),
    });
    setNotice(
      mode === 'rehearsal'
        ? `${value.evidence.length} actions simulated against the recorded targets. No site was contacted.`
        : 'Live run queued. Review its actions in Missions and Approvals.',
    );
    await history.refetch();
  }
  return (
    <section className="durable-card operation-section" aria-label="Learned skill replay">
      <h2>
        {initial.skill.name} · revision {initial.skill.revision}
      </h2>
      <p>
        Rehearsal validates inputs and simulates the recorded actions. A live test opens{' '}
        {initial.program.site} and follows current approvals. Repeated clicks on Run return the same
        run until you choose New run.
      </p>
      {(error || profiles.error || history.error || repairs.error) && (
        <p role="alert">
          {error || workspaceError(profiles.error || history.error || repairs.error)}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <label className="setup-field">
        Inputs (JSON)
        <textarea
          rows={8}
          value={inputs}
          disabled={busy}
          onChange={(event) => {
            setInputs(event.target.value);
            requests.current = {};
          }}
        />
      </label>
      <p>
        Use non-secret values or an explicitly granted secret:// handle for a non-login text field.
        Complete logins and challenges in the live browser.
      </p>
      <label className="setup-field">
        Browser profile
        <select
          value={profileId}
          disabled={busy}
          onChange={(event) => {
            setProfileId(event.target.value);
            requests.current = {};
          }}
        >
          <option value="">Select an Operator profile</option>
          {profiles.data
            ?.filter(
              (profile) =>
                profile.projectId === initial.projectId &&
                profile.site === initial.program.site &&
                profile.agentId === 'operator' &&
                !profile.retired,
            )
            .map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={allowRepair}
          disabled={busy}
          onChange={(event) => {
            setAllowRepair(event.target.checked);
            requests.current = {};
          }}
        />{' '}
        Allow Operator repair (at most three attempts, up to $0.05 each within the run budget)
      </label>
      <div className="button-row">
        <button
          disabled={busy || !initial.skill.enabled}
          onClick={() => void act(() => run('rehearsal'))}
        >
          Rehearse without site access
        </button>
        <button
          disabled={busy || !profileId || !initial.skill.enabled}
          onClick={() => void act(() => run('live'))}
        >
          Run live with approvals
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            requests.current = {};
            setNotice('The next Run click will create a new execution.');
          }}
        >
          New run
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await history.refetch();
              await repairs.refetch();
            })
          }
        >
          Refresh history
        </button>
      </div>
      <ul>
        {history.data?.map((run) => (
          <li key={run.id}>
            {run.mode} · revision {run.revision} · {run.status}
            {run.missionId && (
              <>
                {' '}
                · <a href={`/missions/${run.missionId}`}>Open mission</a> ·{' '}
                <a href="/browser">Live browser</a>
              </>
            )}
            {!!run.evidence.length && (
              <details>
                <summary>Simulated steps</summary>
                <ol>
                  {run.evidence.map((step, index) => (
                    <li key={index}>
                      {step.intent} · {step.result}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </li>
        ))}
      </ul>
      <h3>Proposed locator patches</h3>
      <ul>
        {repairs.data?.map((repair) => (
          <li key={repair.id}>
            {repair.stepId} · {repair.status} · ${repair.costUsd.toFixed(4)}
            <p>{repair.reason}</p>
            {repair.target && (
              <pre className="message-content">{JSON.stringify(repair.target, null, 2)}</pre>
            )}
            {repair.status === 'proposed' && (
              <>
                {(['accept', 'reject'] as const).map((action) => (
                  <button
                    key={action}
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api(`skills/patches/${repair.id}/decision`, learnedRepairSchema, {
                          action,
                          expectedRevision: initial.skill.revision,
                        });
                        await repairs.refetch();
                        if (action === 'accept') await onSaved();
                      })
                    }
                  >
                    {action === 'accept' ? 'Accept patch as a new revision' : 'Reject patch'}
                  </button>
                ))}
              </>
            )}
          </li>
        ))}
      </ul>
      <details>
        <summary>Edit reviewed program and enabled state</summary>
        <form
          className="work-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await api(`${path}/revisions`, learnedVersionSchema, {
                expectedRevision: initial.skill.revision,
                description,
                program: learnedProgramSchema.parse(JSON.parse(program)),
                enabled,
              });
              await onSaved();
            });
          }}
        >
          <label className="setup-field">
            Description
            <input
              value={description}
              required
              maxLength={240}
              disabled={busy}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="setup-field">
            Steps and locators
            <textarea
              rows={16}
              value={program}
              disabled={busy}
              onChange={(event) => setProgram(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(event) => setEnabled(event.target.checked)}
            />{' '}
            Enabled
          </label>
          <button disabled={busy}>Review and save new revision</button>
        </form>
      </details>
      <details>
        <summary>Playwright script for review</summary>
        <pre className="message-content">{initial.script}</pre>
      </details>
    </section>
  );
}
