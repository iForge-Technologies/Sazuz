'use client';
import '../lib/validation';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import {
  evalPresetSchema,
  evalReportSchema,
  evalRunSchema,
  evalSuiteSummarySchema,
  type EvalPreset,
} from '@sazuz/core/evals';
import { projectSchema } from '@sazuz/core/work';
import { api } from '../lib/api';
import { useWorkspaceResource, useWorkspaceSession } from '../lib/use-workspace';
import { WorkPageLayout } from './work-page';
import { WorkspaceLoading, WorkspaceSectionNav } from './workspace-section-nav';
import { RequestNotice } from './durable-shared';
import { formatCost } from './chat-messages';

export function EvalCenter() {
  const session = useWorkspaceSession();
  const projects = useWorkspaceResource('projects', z.array(projectSchema), session.ready, false);
  const suites = useWorkspaceResource(
    'evals/suites',
    z.array(evalSuiteSummarySchema),
    session.ready,
    false,
  );
  const history = useWorkspaceResource('evals', z.array(evalRunSchema), session.ready);
  const [projectId, setProjectId] = useState('');
  const [selection, setSelection] = useState(['inbox-triage', 'research', 'workflows']);
  const [presets, setPresets] = useState<EvalPreset[]>(['balanced', 'budget']);
  const [configured, setConfigured] = useState(false);
  const [judge, setJudge] = useState(false);
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const receipt = useRef<{ hash: string; id: string } | null>(null);
  const report = useWorkspaceResource(
    `evals/${selected}`,
    evalReportSchema,
    session.ready && !!selected,
  );
  const project = projectId || projects.data?.[0]?.id || '';
  async function start() {
    setPending(true);
    setError(null);
    try {
      const body = {
        projectId: project,
        suites: selection,
        presets,
        mode: configured ? 'configured' : 'fixture',
        judge: configured && judge,
      };
      const hash = JSON.stringify(body);
      if (receipt.current?.hash !== hash) receipt.current = { hash, id: crypto.randomUUID() };
      const created = await api('evals', evalRunSchema, { ...body, requestId: receipt.current.id });
      receipt.current = null;
      setSelected(created.id);
      await history.refetch();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  const data = report.data;
  return (
    <WorkPageLayout
      current="Evals"
      title="Evaluations"
      description="Compare model presets on recorded tasks and inspect the policy decisions behind each result."
      actions={<Link href="/settings?section=models">Model settings</Link>}
    >
      <WorkspaceSectionNav
        label="Evaluation sections"
        sections={[
          { id: 'eval-create', label: 'New comparison' },
          { id: 'eval-history', label: 'History' },
        ]}
      />
      {session.loading || (session.ready && suites.isPending) ? (
        <WorkspaceLoading>Loading evaluation suites…</WorkspaceLoading>
      ) : null}
      <RequestNotice
        error={
          error || session.error || projects.error || suites.error || history.error || report.error
        }
      />
      <form
        className="durable-card operation-section eval-composer"
        id="eval-create"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <h2>New comparison</h2>
        <label className="setup-field">
          Project
          <select
            value={project}
            disabled={pending}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {!projects.data?.length && <option value="">Create a project in Chat first</option>}
            {projects.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset disabled={pending}>
          <legend>Task suites</legend>
          {suites.data?.map((suite) => (
            <label className="setup-check" key={suite.suite}>
              <input
                type="checkbox"
                checked={selection.includes(suite.suite)}
                onChange={(event) =>
                  setSelection(
                    event.target.checked
                      ? [...selection, suite.suite]
                      : selection.filter((name) => name !== suite.suite),
                  )
                }
              />
              <span>
                {suite.suite} ({suite.cases} cases) — {suite.description}
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset disabled={pending}>
          <legend>Model presets</legend>
          {evalPresetSchema.options.map((preset) => (
            <label className="setup-check" key={preset}>
              <input
                type="checkbox"
                checked={presets.includes(preset)}
                onChange={(event) =>
                  setPresets(
                    event.target.checked
                      ? [...presets, preset]
                      : presets.filter((name) => name !== preset),
                  )
                }
              />
              {preset}
            </label>
          ))}
        </fieldset>
        <label className="setup-check">
          <input
            type="checkbox"
            checked={configured}
            disabled={pending}
            onChange={(event) => setConfigured(event.target.checked)}
          />
          Use configured models (may incur model charges)
        </label>
        <p>
          {configured
            ? 'Uses the selected presets and current project privacy, model and budget settings. All tools remain simulated. Interrupted model requests are retained without retry.'
            : 'Fixture mode uses scripted responses with zero model calls and zero cost. It verifies the harness and policy boundaries; it does not measure model quality.'}
        </p>
        {configured && (
          <label className="setup-check">
            <input
              type="checkbox"
              checked={judge}
              disabled={pending}
              onChange={(event) => setJudge(event.target.checked)}
            />
            Include an optional model judge; its cost is reported separately
          </label>
        )}
        <button
          className="button-primary"
          type="submit"
          disabled={pending || !session.ready || !project || !selection.length || !presets.length}
        >
          {pending ? 'Queuing…' : 'Run comparison'}
        </button>
      </form>
      <section
        className="durable-card operation-section eval-history"
        aria-label="Evaluation history"
        id="eval-history"
      >
        <h2>History</h2>
        {!history.data?.length && <p>No evaluations yet.</p>}
        {history.data?.map((item) => (
          <p key={item.id}>
            <button
              type="button"
              aria-pressed={selected === item.id}
              onClick={() => setSelected(item.id)}
            >
              {item.createdAt.replace('T', ' ').slice(0, 19)} UTC · {item.mode} ·{' '}
              {item.presets.join(', ')}
            </button>{' '}
            {item.status} · {item.passedCases}/{item.totalCases} passed · {formatCost(item.costUsd)}
          </p>
        ))}
      </section>
      {data && (
        <section className="durable-card operation-section" aria-label="Selected evaluation">
          <h2>Comparison results</h2>
          <p role="status">
            {data.status} · {data.completedCases}/{data.totalCases} recorded · {data.passedCases}{' '}
            passed · {formatCost(data.costUsd)} total, including {formatCost(data.judgeCostUsd)} for
            the judge.
          </p>
          <p>
            {data.mode === 'fixture'
              ? 'Scripted fixture results. No model inference was used.'
              : 'Configured-model results with simulated tools.'}{' '}
            Security presets are recorded per case; model presets control routing.
          </p>
          <a href={`/api/evals/${data.id}/report`} target="_blank" rel="noreferrer">
            Open standalone HTML report
          </a>
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Evaluation comparison table"
          >
            <table>
              <caption>Cases, model usage and outcomes</caption>
              <thead>
                <tr>
                  <th scope="col">Suite / case</th>
                  <th scope="col">Preset / models</th>
                  <th scope="col">Result</th>
                  <th scope="col">Cost / latency</th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((item) => (
                  <tr key={item.id}>
                    <th scope="row">
                      {item.suite} / {item.caseId}
                    </th>
                    <td>
                      {item.preset}
                      <br />
                      {item.models
                        .map((model) => `${model.providerId}/${model.modelId}`)
                        .join(', ') || 'Scripted fixture'}
                    </td>
                    <td>
                      {item.passed ? 'Pass' : 'Failed or unverified'} · {item.outcome}
                    </td>
                    <td>
                      {formatCost(item.costUsd)} / {item.latencyMs.toFixed(0)} ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.results
            .filter((item) => !item.passed)
            .map((item) => (
              <details key={item.id}>
                <summary>
                  {item.suite} / {item.caseId} / {item.preset}: grader evidence
                </summary>
                <ul>
                  {item.grades
                    .filter((grade) => grade.passed !== true)
                    .map((grade, index) => (
                      <li key={index}>
                        {grade.description}: {grade.evidence}
                      </li>
                    ))}
                </ul>
              </details>
            ))}
        </section>
      )}
    </WorkPageLayout>
  );
}
