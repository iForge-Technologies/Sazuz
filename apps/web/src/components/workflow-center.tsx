'use client';
import '../lib/validation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { z } from 'zod';
import { projectSchema } from '@sazuz/core/work';
import {
  workflowSchema,
  workflowDefinitionSchema,
  workflowRunSchema,
  workflowData,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowAction,
} from '@sazuz/core/workflows';
import { api } from '../lib/api';
import { useWorkspaceResource, useWorkspaceSession, workspaceError } from '../lib/use-workspace';
import { blankWorkflow, newWorkflowNode, workflowNodeLabels } from '../lib/workflow-editor';
import { WorkPageLayout } from './work-page';
import { WorkflowNodeEditor } from './workflow-node-editor';
import { WorkflowDraftComposer } from './workflow-draft-composer';
import { WorkspaceLoading, WorkspaceSectionNav } from './workspace-section-nav';

const WorkflowDiagram = dynamic(() => import('./workflow-diagram'), { ssr: false });
export function WorkflowCenter({ id }: { id?: string }) {
  const session = useWorkspaceSession();
  const list = useWorkspaceResource('workflows', z.array(workflowSchema), session.ready, false);
  const projects = useWorkspaceResource('projects', z.array(projectSchema), session.ready, false);
  const selected = useWorkspaceResource(
    'workflows/' + id,
    workflowSchema,
    session.ready && !!id,
    false,
  );
  const [creating, setCreating] = useState(false),
    [project, setProject] = useState('');
  const [error, setError] = useState('');
  return (
    <WorkPageLayout
      current="Workflows"
      title={selected.data?.definition.name ?? 'Workflows'}
      description="Connect predictable steps with agents where judgement helps. Review a revision before running or scheduling it."
    >
      {session.loading || list.isPending || (id && selected.isPending) ? (
        <WorkspaceLoading>Loading workflows…</WorkspaceLoading>
      ) : null}
      {(error || session.error || list.error || selected.error || projects.error) && (
        <p role="alert" className="setup-error">
          {error || workspaceError(session.error || list.error || selected.error || projects.error)}
        </p>
      )}
      {!id && (
        <>
          <section className="durable-card operation-section workflow-create">
            <h2>Create a workflow</h2>
            <div className="durable-actions">
              <label className="setup-field">
                Project
                <select
                  value={project || projects.data?.[0]?.id || ''}
                  onChange={(e) => setProject(e.target.value)}
                >
                  {projects.data?.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={creating || !projects.data?.length}
                onClick={() =>
                  void (async () => {
                    setCreating(true);
                    setError('');
                    try {
                      const value = await api('workflows', workflowSchema, {
                        projectId: project || projects.data![0]!.id,
                        expectedVersion: 0,
                        definition: blankWorkflow(),
                      });
                      window.location.assign('/workflows/' + value.id);
                    } catch (cause) {
                      setError(workspaceError(cause));
                      setCreating(false);
                    }
                  })()
                }
              >
                Create workflow
              </button>
            </div>
          </section>
          <nav className="workflow-catalogue" aria-label="Saved workflows">
            {list.data?.map((workflow) => (
              <Link className="durable-card" key={workflow.id} href={'/workflows/' + workflow.id}>
                <h2>{workflow.definition.name}</h2>
                <p>
                  {workflow.definition.description || `${workflow.definition.nodes.length} nodes`}
                </p>
                <span>
                  Revision {workflow.revision} ·{' '}
                  {workflow.activeRevision ? `Reviewed r${workflow.activeRevision}` : 'Draft'} ·{' '}
                  {workflow.enabled ? 'Trigger enabled' : 'Trigger off'}
                </span>
              </Link>
            ))}
          </nav>
          {list.data?.length === 0 && (
            <p>
              No workflows yet. Create one or install a template from{' '}
              <Link href="/recipes">Recipes</Link>.
            </p>
          )}
        </>
      )}
      {selected.data && (
        <WorkflowEditor
          key={selected.data.id + ':' + selected.data.version}
          workflow={selected.data}
          refresh={async () => {
            await selected.refetch();
          }}
        />
      )}
    </WorkPageLayout>
  );
}

function WorkflowEditor({
  workflow,
  refresh,
}: {
  workflow: Workflow;
  refresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<WorkflowDefinition>(workflow.definition);
  const [selected, setSelected] = useState(draft.nodes[0]!.id),
    [kind, setKind] = useState<WorkflowAction['kind']>('tool');
  const [from, setFrom] = useState(draft.nodes[0]!.id),
    [to, setTo] = useState(''),
    [branch, setBranch] = useState('');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [input, setInput] = useState('{}'),
    [test, setTest] = useState(false),
    [runId, setRunId] = useState('');
  const [json, setJson] = useState(JSON.stringify(draft, null, 2));
  const catalogue = useWorkspaceResource('workflows', z.array(workflowSchema), true, false);
  const [referenceId, setReferenceId] = useState('');
  const references =
    catalogue.data?.filter(
      (item) =>
        item.id !== workflow.id &&
        item.projectId === workflow.projectId &&
        item.activeRevision !== null,
    ) ?? [];
  const reference = references.find((item) => item.id === referenceId) ?? references[0];
  const history = useWorkspaceResource(
    'workflows/' + workflow.id + '/versions',
    z.array(z.object({ revision: z.number(), reviewed: z.boolean(), createdAt: z.string() })),
    true,
    false,
  );
  const runs = useWorkspaceResource(
    'workflows/' + workflow.id + '/runs',
    z.array(workflowRunSchema),
    true,
  );
  const node = draft.nodes.find((item) => item.id === selected);
  const displayed = runs.data?.find((run) => run.id === runId) ?? runs.data?.[0];
  const changed = JSON.stringify(draft) !== JSON.stringify(workflow.definition);
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      setError(workspaceError(cause, 'Check the workflow configuration and JSON.'));
    } finally {
      setBusy(false);
    }
  }
  function connect(source: string, target: string, named = branch) {
    const action = draft.nodes.find((item) => item.id === source)?.action;
    const selectedBranch =
      named ||
      (action?.kind === 'condition'
        ? 'true'
        : action?.kind === 'classify'
          ? action.branches[0]
          : undefined);
    if (!source || !target || source === target) return;
    setDraft({
      ...draft,
      edges: [
        ...draft.edges,
        { from: source, to: target, ...(selectedBranch ? { branch: selectedBranch } : {}) },
      ],
    });
  }
  return (
    <>
      <WorkspaceSectionNav
        label="Workflow editor sections"
        sections={[
          { id: 'workflow-describe', label: 'Describe a workflow' },
          { id: 'workflow-build', label: 'Build & review' },
          { id: 'workflow-run', label: 'Run & history' },
        ]}
      />
      <WorkflowDraftComposer
        projectId={workflow.projectId}
        apply={(definition) => {
          setDraft(definition);
          setSelected(definition.nodes[0]!.id);
          setFrom(definition.nodes[0]!.id);
          setTo('');
          setJson(JSON.stringify(definition, null, 2));
          setNotice(
            'Generated graph applied. Inspect and edit its steps, then save and review the revision.',
          );
        }}
      />
      <section className="durable-card workflow-editor operation-section" id="workflow-build">
        <div className="work-heading">
          <h2>Build and review</h2>
          <span>
            Revision {workflow.revision} · {workflow.enabled ? 'Trigger enabled' : 'Trigger off'}
            {changed ? ' · Unsaved changes' : ''}
          </span>
        </div>
        {error && (
          <p role="alert" className="setup-error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <label className="setup-field">
          Workflow name
          <input
            value={draft.name}
            maxLength={160}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="setup-field">
          Description
          <textarea
            value={draft.description}
            rows={2}
            maxLength={2000}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </label>
        <div className="durable-actions">
          <label className="setup-field">
            Parallel nodes
            <input
              type="number"
              min={1}
              max={4}
              value={draft.concurrency}
              onChange={(e) => setDraft({ ...draft, concurrency: Number(e.target.value) })}
            />
          </label>
          <label className="setup-field">
            Node type
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as WorkflowAction['kind'])}
            >
              {Object.entries(workflowNodeLabels)
                .filter(([key]) => key !== 'trigger')
                .map(([key, label]) => (
                  <option value={key} key={key}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          <button
            disabled={
              draft.nodes.length >= 64 || ((kind === 'map' || kind === 'workflow') && !reference)
            }
            onClick={() => {
              const id = 'node_' + crypto.randomUUID().slice(0, 8);
              const added = newWorkflowNode(
                kind,
                id,
                draft.nodes.length,
                reference ? { id: reference.id, revision: reference.activeRevision! } : undefined,
              );
              setDraft({
                ...draft,
                nodes: [...draft.nodes, added],
                edges: [
                  ...draft.edges,
                  {
                    from: selected,
                    to: id,
                    ...(node?.action.kind === 'condition'
                      ? { branch: 'true' }
                      : node?.action.kind === 'classify'
                        ? { branch: node.action.branches[0]! }
                        : {}),
                  },
                ],
              });
              setSelected(id);
            }}
          >
            Add node
          </button>
          {(kind === 'map' || kind === 'workflow') && (
            <label className="setup-field">
              Reviewed sub-workflow
              <select
                value={reference?.id ?? ''}
                onChange={(event) => setReferenceId(event.target.value)}
              >
                {!references.length && (
                  <option value="">Create and review a sub-workflow in this project first</option>
                )}
                {references.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.definition.name} · r{item.activeRevision}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <WorkflowDiagram
          graph={draft}
          selected={selected}
          select={setSelected}
          connect={connect}
          move={(id, position) =>
            setDraft({
              ...draft,
              nodes: draft.nodes.map((item) => (item.id === id ? { ...item, position } : item)),
            })
          }
        />
        <div className="workflow-edit-grid">
          <div>
            <label className="setup-field">
              Select node
              <select value={selected} onChange={(e) => setSelected(e.target.value)}>
                {draft.nodes.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.label} ({item.id})
                  </option>
                ))}
              </select>
            </label>
            {node && (
              <WorkflowNodeEditor
                key={node.id + ':' + JSON.stringify(node.action)}
                node={node}
                save={(updated) => {
                  setDraft({
                    ...draft,
                    nodes: draft.nodes.map((item) => (item.id === updated.id ? updated : item)),
                  });
                  setNotice('Node changes applied. Save the draft to create a revision.');
                }}
                remove={() => {
                  setDraft({
                    ...draft,
                    nodes: draft.nodes.filter((item) => item.id !== selected),
                    edges: draft.edges.filter(
                      (edge) => edge.from !== selected && edge.to !== selected,
                    ),
                  });
                  setSelected(draft.nodes[0]!.id);
                }}
              />
            )}
          </div>
          <section>
            <h3>Connections</h3>
            <p>
              Branches wait for their incoming steps. Conditions use true/false; classifiers use
              their named branches.
            </p>
            <label className="setup-field">
              From
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                {draft.nodes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="setup-field">
              To
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">Choose node</option>
                {draft.nodes
                  .filter((item) => item.action.kind !== 'trigger')
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
              </select>
            </label>
            <label className="setup-field">
              Branch (conditions only)
              <input value={branch} onChange={(e) => setBranch(e.target.value)} />
            </label>
            <button onClick={() => connect(from, to)}>Add connection</button>
            <ul>
              {draft.edges.map((edge, index) => (
                <li key={index}>
                  {edge.from} → {edge.to}
                  {edge.branch ? ` (${edge.branch})` : ''}{' '}
                  <button
                    aria-label={`Remove connection ${edge.from} to ${edge.to}`}
                    onClick={() =>
                      setDraft({ ...draft, edges: draft.edges.filter((_, i) => i !== index) })
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <details>
          <summary>Edit workflow JSON</summary>
          <button onClick={() => setJson(JSON.stringify(draft, null, 2))}>
            Load current graph
          </button>
          <label className="setup-field">
            Workflow definition
            <textarea
              rows={18}
              spellCheck={false}
              value={json}
              onChange={(e) => setJson(e.target.value)}
            />
          </label>
          <button
            onClick={() => {
              try {
                const graph = workflowDefinitionSchema.parse(JSON.parse(json));
                setDraft(graph);
                setSelected(graph.nodes[0]!.id);
                setError('');
              } catch {
                setError(
                  'The workflow JSON is invalid. Check node IDs, connections and configuration.',
                );
              }
            }}
          >
            Apply workflow JSON
          </button>
        </details>
        <div className="durable-actions">
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api(
                  'workflows/' + workflow.id,
                  workflowSchema,
                  {
                    projectId: workflow.projectId,
                    expectedVersion: workflow.version,
                    definition: workflowDefinitionSchema.parse(draft),
                  },
                  'PUT',
                );
                await refresh();
              })
            }
          >
            Save draft
          </button>
          <button
            disabled={busy || changed}
            onClick={() =>
              void act(async () => {
                await api('workflows/' + workflow.id + '/review', workflowSchema, {
                  expectedVersion: workflow.version,
                  revision: workflow.revision,
                  enabled: false,
                });
                await refresh();
              })
            }
          >
            Review revision
          </button>
          <button
            disabled={busy || changed}
            onClick={() =>
              void act(async () => {
                await api('workflows/' + workflow.id + '/review', workflowSchema, {
                  expectedVersion: workflow.version,
                  revision: workflow.revision,
                  enabled: !workflow.enabled,
                });
                await refresh();
              })
            }
          >
            {workflow.enabled ? 'Disable trigger' : 'Review and enable trigger'}
          </button>
        </div>
        <p className="field-help">
          Review confirms this graph and exact sub-workflow revisions. Each effect still follows
          your policy and current account grants.
        </p>
        <details>
          <summary>Revision history</summary>
          <ul>
            {history.data?.map((version) => (
              <li key={version.revision}>
                Revision {version.revision} · {version.reviewed ? 'Reviewed' : 'Draft'}{' '}
                <button
                  onClick={() =>
                    void act(async () => {
                      const prior = await api(
                        `workflows/${workflow.id}?revision=${version.revision}`,
                        workflowSchema,
                      );
                      setDraft(prior.definition);
                      setSelected(prior.definition.nodes[0]!.id);
                      setNotice('Previous revision loaded. Save to create a new draft.');
                    })
                  }
                >
                  Load revision {version.revision}
                </button>
              </li>
            ))}
          </ul>
        </details>
      </section>
      <section className="durable-card operation-section" id="workflow-run">
        <h2>Run workflow</h2>
        <label className="setup-field">
          Run input (JSON)
          <textarea value={input} rows={4} onChange={(e) => setInput(e.target.value)} />
        </label>
        <label className="setup-check">
          <input type="checkbox" checked={test} onChange={(e) => setTest(e.target.checked)} />
          Test run with pinned outputs
        </label>
        <button
          disabled={busy || changed || workflow.activeRevision === null}
          onClick={() =>
            void act(async () => {
              const result = await api(`workflows/${workflow.id}/runs`, workflowRunSchema, {
                revision: workflow.activeRevision,
                requestId: crypto.randomUUID(),
                input: workflowData.parse(JSON.parse(input)),
                test,
              });
              setRunId(result.id);
              await runs.refetch();
              setNotice('Workflow queued. Approvals appear in the Approvals inbox.');
            })
          }
        >
          Run reviewed revision
        </button>
        <h3>Run history</h3>
        <label className="setup-field">
          Run
          <select value={displayed?.id ?? ''} onChange={(e) => setRunId(e.target.value)}>
            <option value="">Choose run</option>
            {runs.data?.map((run) => (
              <option key={run.id} value={run.id}>
                {run.createdAt} · r{run.revision} · {run.status}
                {run.test ? ' · test' : ''}
              </option>
            ))}
          </select>
        </label>
        {displayed && (
          <div className="workflow-history">
            <p>
              {displayed.status} · {displayed.modelFree ? 'No model calls' : 'Includes agent steps'}{' '}
              · <Link href={'/missions/' + displayed.missionId}>Open mission and approvals</Link>
            </p>
            <details>
              <summary>Workflow input and output</summary>
              <pre>
                {JSON.stringify({ input: displayed.input, output: displayed.output }, null, 2)}
              </pre>
            </details>
            {displayed.nodes.map((item) => (
              <details key={item.id}>
                <summary>
                  {item.key} · {item.status} · attempt {item.attempt}
                  {item.pinned ? ' · pinned test data' : ''}
                </summary>
                <p>
                  {item.reason}
                  {item.tainted ? ' · Untrusted input' : ''}
                  {item.privateOnly ? ' · Private' : ''}
                </p>
                <pre>
                  {JSON.stringify(
                    { input: item.input, output: item.output, branch: item.branch },
                    null,
                    2,
                  )}
                </pre>
              </details>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
