'use client';
import '../lib/validation';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { z } from 'zod';
import { runDetailSchema, forkInputSchema } from '@sazuz/core/replay';
import { modelCatalogSchema } from '@sazuz/llm/contracts';
import { skillSummarySchema } from '@sazuz/core/skills';
import { api } from '../lib/api';
import { useWorkspaceResource, useWorkspaceSession, workspaceError } from '../lib/use-workspace';
import { WorkPageLayout } from './work-page';
import { WorkspaceLoading, WorkspaceSectionNav } from './workspace-section-nav';
import { RequestNotice, RunStatus, agentLabels } from './durable-shared';
import { formatCost } from './chat-messages';

export function RunWorkspace({ id }: { id: string }) {
  const session = useWorkspaceSession();
  const router = useRouter();
  const detail = useWorkspaceResource(`runs/${id}/detail`, runDetailSchema, session.ready);
  const models = useWorkspaceResource('models', modelCatalogSchema, session.ready, false);
  const skills = useWorkspaceResource('skills', z.array(skillSummarySchema), session.ready, false);
  const [stepId, setStepId] = useState('');
  const [model, setModel] = useState('');
  const [skill, setSkill] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef<string | null>(null);
  const data = detail.data;
  const selectedStep = stepId || data?.steps[0]?.id || '';
  const changed = () => {
    requestId.current = null;
  };
  async function fork() {
    setBusy(true);
    setError('');
    try {
      requestId.current ??= crypto.randomUUID();
      const body = forkInputSchema.parse({
        requestId: requestId.current,
        stepId: selectedStep,
        model: model ? (JSON.parse(model) as unknown) : null,
        skill: skill ? (JSON.parse(skill) as unknown) : null,
        prompt,
      });
      const result = await api(`runs/${id}/forks`, runDetailSchema, body);
      requestId.current = null;
      router.push(`/runs/${result.run.id}`);
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <WorkPageLayout
      current="Missions"
      title="Run replay"
      description="Inspect a run and compare a simulated continuation from any recorded step."
    >
      {data && (
        <WorkspaceSectionNav
          label="Run sections"
          sections={[
            { id: 'run-summary', label: 'Overview' },
            { id: 'run-fork', label: 'Fork a step' },
            { id: 'run-steps', label: 'Step timeline' },
          ]}
        />
      )}
      {session.loading || (session.ready && detail.isPending) ? (
        <WorkspaceLoading>Loading run evidence…</WorkspaceLoading>
      ) : null}
      <RequestNotice
        error={session.error || detail.error || models.error || skills.error}
        message={error}
      />
      {data && (
        <>
          <section
            className="durable-card operation-section operation-summary"
            aria-label="Run summary"
            id="run-summary"
          >
            <h2>{data.title}</h2>
            <RunStatus status={data.run.status} />
            <p>
              {agentLabels[data.run.agentId]} · {data.run.step} steps ·{' '}
              {formatCost(data.run.costUsd)}
            </p>
            <Link href={`/missions/${data.run.missionId}`}>
              Mission, approvals and run controls
            </Link>
            {data.run.reason && <p>{data.run.reason}</p>}
            {data.replay && (
              <>
                <p className="setup-notice">
                  Simulation: all tools use recorded fixtures. No live tool actions or reads occur.
                  Configured model calls consume budget.
                </p>
                <p>
                  <Link href={`/runs/${data.replay.sourceRunId}`}>Original run</Link> · source
                  position {data.replay.sourceOrdinal} ·{' '}
                  {data.replay.reconstructed
                    ? 'Reconstructed historical context'
                    : 'Saved step context'}
                </p>
                <div
                  className="table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label="Run comparison table"
                >
                  <table>
                    <caption>Run comparison</caption>
                    <thead>
                      <tr>
                        <th scope="col">Run</th>
                        <th scope="col">Steps</th>
                        <th scope="col">Model cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <th scope="row">Original, entire run</th>
                        <td>{data.source?.step ?? 'Unavailable'}</td>
                        <td>{data.source ? formatCost(data.source.costUsd) : 'Unavailable'}</td>
                      </tr>
                      <tr>
                        <th scope="row">Fork, selected continuation</th>
                        <td>{data.run.step}</td>
                        <td>{formatCost(data.run.costUsd)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {!!data.approvals.filter((item) => item.status === 'pending').length && (
              <p>
                <Link href="/approvals">Review pending actions</Link>
                {data.replay ? ' (simulated)' : ''}
              </p>
            )}
          </section>
          <section className="durable-card operation-section" aria-label="Fork run" id="run-fork">
            <h2>Fork from a step</h2>
            <p>
              Continue one agent run with copied context and mocked tools. The fork has a new
              allowance within your current project and global caps.
            </p>
            <form
              className="work-form setup-form"
              onSubmit={(event) => {
                event.preventDefault();
                void fork();
              }}
            >
              <label className="setup-field">
                Starting step
                <select
                  value={selectedStep}
                  onChange={(event) => {
                    changed();
                    setStepId(event.target.value);
                  }}
                >
                  {data.steps.map((step, index) => (
                    <option key={step.id} value={step.id}>
                      {index + 1}. {step.toolName ?? step.kind} ·{' '}
                      {step.modelId ?? agentLabels[step.agentId]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="setup-field">
                Model
                <select
                  value={model}
                  onChange={(event) => {
                    changed();
                    setModel(event.target.value);
                  }}
                >
                  <option value="">Current configured routing</option>
                  {models.data?.map((item) => (
                    <option
                      key={`${item.providerId}/${item.id}`}
                      value={JSON.stringify({ providerId: item.providerId, modelId: item.id })}
                    >
                      {item.providerId} / {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="setup-field">
                Reviewed skill
                <select
                  value={skill}
                  onChange={(event) => {
                    changed();
                    setSkill(event.target.value);
                  }}
                >
                  <option value="">Keep copied context</option>
                  {skills.data
                    ?.filter((item) => item.enabled)
                    .map((item) => (
                      <option
                        key={item.id}
                        value={JSON.stringify({ id: item.id, revision: item.revision })}
                      >
                        {item.name} · revision {item.revision}
                      </option>
                    ))}
                </select>
              </label>
              <label className="setup-field">
                Additional instruction
                <textarea
                  value={prompt}
                  maxLength={16000}
                  onChange={(event) => {
                    changed();
                    setPrompt(event.target.value);
                  }}
                  placeholder="Optional change for this continuation"
                />
              </label>
              <button type="submit" disabled={busy || !selectedStep}>
                {busy ? 'Creating fork…' : 'Create simulated fork'}
              </button>
            </form>
          </section>
          <section
            className="mission-timeline operation-section"
            aria-label="Run steps"
            id="run-steps"
          >
            <h2>Step timeline</h2>
            <ol>
              {data.steps.map((step, index) => (
                <li key={step.id}>
                  <article>
                    <h3>
                      {index + 1}. {step.toolName ?? step.kind}
                    </h3>
                    <p className="message-content">{step.content}</p>
                    {step.modelId && (
                      <p>
                        {step.providerId} / {step.modelId} · {step.inputTokens} input /{' '}
                        {step.outputTokens} output tokens · {formatCost(step.costUsd)}
                      </p>
                    )}
                    {step.prompt && (
                      <details className="tool-observation">
                        <summary>Model prompt</summary>
                        <pre>{step.prompt}</pre>
                      </details>
                    )}
                    {(step.toolArgs !== null || step.toolResult !== null) && (
                      <details className="tool-observation">
                        <summary>Action details</summary>
                        <pre>
                          {JSON.stringify(
                            { args: step.toolArgs, result: step.toolResult },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        changed();
                        setStepId(step.id);
                        document.querySelector<HTMLSelectElement>('select')?.focus();
                      }}
                    >
                      Select this step for a fork
                    </button>
                  </article>
                </li>
              ))}
            </ol>
          </section>
          {!!data.forks.length && (
            <section className="durable-card">
              <h2>Forks</h2>
              <ul>
                {data.forks.map((item) => (
                  <li key={item.runId}>
                    <Link href={`/runs/${item.runId}`}>
                      {item.model
                        ? `${item.model.providerId} / ${item.model.modelId}`
                        : 'Configured model'}{' '}
                      · source position {item.sourceOrdinal}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </WorkPageLayout>
  );
}
