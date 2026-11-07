'use client';
import '../lib/validation';
import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type NodeProps,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { z } from 'zod';
import {
  s2aGraphSchema,
  s2aNodeSchema,
  s2aRecordSchema,
  s2aScheduleSchema,
  type s2aRunInputSchema,
  type S2aGraph,
  type S2aNode,
} from '@sazuz/core/s2a';
import { missionSchema, runSchema } from '@sazuz/core/missions';
import { projectSchema } from '@sazuz/core/work';
import { agentRoleSchema } from '@sazuz/core/agents';
import { api, ApiError } from '../lib/api';
import { useWorkspaceResource, useWorkspaceSession, workspaceError } from '../lib/use-workspace';
import { WorkPageLayout } from './work-page';
import { RequestNotice, RunStatus } from './durable-shared';

type Workflow = z.infer<typeof s2aRecordSchema>;
const toolListSchema = z.array(
  z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
    effect: z.string(),
  }),
);
const starter: S2aGraph = {
  entry: 'start',
  nodes: [
    {
      id: 'start',
      name: 'Prepare data',
      kind: 'value',
      value: { message: 'Hello from S2A' },
      next: null,
      x: 70,
      y: 80,
    },
  ],
};
function CanvasNode({
  data,
  selected,
}: NodeProps<Node<{ label: string; kind: string; entry: boolean }>>) {
  return (
    <div className={`s2a-node ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <small>
        {data.entry ? 'START · ' : ''}
        {data.kind.toUpperCase()}
      </small>
      <strong>{data.label}</strong>
      {data.kind === 'condition' ? (
        <>
          <Handle id="yes" type="source" position={Position.Bottom} style={{ left: '30%' }} />
          <span className="s2a-branch">Yes / No</span>
          <Handle id="no" type="source" position={Position.Bottom} style={{ left: '70%' }} />
        </>
      ) : (
        <Handle id="next" type="source" position={Position.Bottom} />
      )}
    </div>
  );
}
const nodeTypes = { s2a: CanvasNode };
function JsonField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState('');
  return (
    <label>
      {label}
      <textarea
        value={text}
        rows={6}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            onChange(JSON.parse(next) as unknown);
            setError('');
            event.target.setCustomValidity('');
          } catch {
            setError('Enter valid JSON before saving.');
            event.target.setCustomValidity('Enter valid JSON before saving.');
          }
        }}
        aria-invalid={Boolean(error)}
      />
      {error && <span role="alert">{error}</span>}
    </label>
  );
}
function nextTargets(node: S2aNode) {
  return node.kind === 'condition'
    ? ([
        ['yes', node.yes],
        ['no', node.no],
      ] as const)
    : ([['next', node.next]] as const);
}

export function S2aStudio() {
  const session = useWorkspaceSession();
  const workflows = useWorkspaceResource('s2a', z.array(s2aRecordSchema), session.ready, false);
  const projects = useWorkspaceResource('projects', z.array(projectSchema), session.ready, false);
  const tools = useWorkspaceResource('s2a/tools', toolListSchema, session.ready, false);
  const [selected, setSelected] = useState<Workflow | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <WorkPageLayout
      current="S2A"
      title="S2A Studio"
      description="Build reusable automations with tools, agents and human checkpoints."
      actions={
        <button
          disabled={!projects.data?.length}
          onClick={() => {
            setSelected(null);
            setCreating(true);
          }}
        >
          New workflow
        </button>
      }
    >
      <RequestNotice error={workflows.error || projects.error || tools.error || session.error} />
      {!projects.data?.length && session.ready && (
        <p>
          Create a project in <Link href="/chat">Chat</Link> to organize your workflows.
        </p>
      )}
      <div className="integration-tabs">
        {workflows.data?.map((workflow) => (
          <button
            key={workflow.id}
            aria-pressed={selected?.id === workflow.id}
            onClick={() => {
              setSelected(workflow);
              setCreating(false);
            }}
          >
            {workflow.name}
            <small>
              v{workflow.revision}
              {workflow.publishedRevision ? ' · Published' : ' · Draft'}
            </small>
          </button>
        ))}
      </div>
      {(creating || selected) && (
        <WorkflowEditor
          key={selected ? `${selected.id}:${selected.revision}` : 'new'}
          initial={selected}
          projects={projects.data ?? []}
          tools={tools.data ?? []}
          saved={(workflow) => {
            setSelected(workflow);
            setCreating(false);
            void workflows.refetch();
          }}
        />
      )}
      {!creating && !selected && (
        <div className="integration-empty">
          <h2>From a task to a repeatable workflow</h2>
          <p>
            Add a data node, connect a tool or an agent, then insert an approval before
            consequential work. Each run appears in Missions.
          </p>
          <p>Start with a new workflow or select a saved one above.</p>
        </div>
      )}
    </WorkPageLayout>
  );
}
function WorkflowEditor({
  initial,
  projects,
  tools,
  saved,
}: {
  initial: Workflow | null;
  projects: z.infer<typeof projectSchema>[];
  tools: z.infer<typeof toolListSchema>;
  saved: (workflow: Workflow) => void;
}) {
  const editorRef = useRef<HTMLElement>(null);
  const [importVersion, setImportVersion] = useState(0);
  const pendingRun = useRef<z.infer<typeof s2aRunInputSchema> | null>(null);
  const [graph, setGraph] = useState<S2aGraph>(initial?.graph ?? structuredClone(starter));
  const [name, setName] = useState(initial?.name ?? 'New workflow');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [projectId, setProjectId] = useState(initial?.projectId ?? projects[0]?.id ?? '');
  const [selected, setSelected] = useState(graph.entry);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState<unknown>({});
  const [missionId, setMissionId] = useState('');
  const history = useWorkspaceResource(
    `s2a/${initial?.id ?? 'none'}/runs`,
    z.array(z.object({ missionId: z.string(), revision: z.number(), run: runSchema })),
    Boolean(initial),
  );
  const node = graph.nodes.find((item) => item.id === selected);
  const dirty =
    !initial ||
    name !== initial.name ||
    description !== initial.description ||
    JSON.stringify(graph) !== JSON.stringify(initial.graph);
  const valid = s2aGraphSchema.safeParse(graph);
  const nodes = useMemo(
    () =>
      graph.nodes.map((item) => ({
        id: item.id,
        type: 's2a',
        position: { x: item.x, y: item.y },
        selected: item.id === selected,
        data: { label: item.name, kind: item.kind, entry: item.id === graph.entry },
      })),
    [graph, selected],
  );
  const edges = useMemo(
    () =>
      graph.nodes.flatMap((item) =>
        nextTargets(item).flatMap(([handle, target]) =>
          target
            ? [
                {
                  id: `${item.id}:${handle}`,
                  source: item.id,
                  sourceHandle: handle,
                  target,
                  label: item.kind === 'condition' ? handle : undefined,
                },
              ]
            : [],
        ),
      ),
    [graph],
  );
  function update(id: string, fields: Partial<S2aNode>) {
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.map((item) =>
        item.id === id ? s2aNodeSchema.parse({ ...item, ...fields }) : item,
      ),
    }));
  }
  function connect(id: string, handle: string, target: string | null) {
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.map((item) =>
        item.id === id
          ? item.kind === 'condition'
            ? { ...item, [handle === 'no' ? 'no' : 'yes']: target }
            : { ...item, next: target }
          : item,
      ),
    }));
  }
  function add(kind: S2aNode['kind']) {
    const id = `node_${crypto.randomUUID().slice(0, 8)}`;
    const base = {
      id,
      name:
        kind === 'agent'
          ? 'Agent task'
          : kind === 'tool'
            ? 'Tool action'
            : kind === 'approval'
              ? 'Review action'
              : kind === 'condition'
                ? 'Choose a branch'
                : 'Map data',
      x: 70 + (graph.nodes.length % 3) * 240,
      y: 80 + Math.floor(graph.nodes.length / 3) * 150,
    };
    const added =
      kind === 'condition'
        ? s2aNodeSchema.parse({
            ...base,
            kind,
            left: true,
            right: true,
            operator: 'equals',
            yes: null,
            no: null,
          })
        : s2aNodeSchema.parse({
            ...base,
            next: null,
            kind,
            ...(kind === 'value'
              ? { value: {} }
              : kind === 'tool'
                ? {
                    tool: tools.find((item) => !item.name.startsWith('s2a.'))?.name ?? 'time.now',
                    args: {},
                  }
                : kind === 'agent'
                  ? {
                      prompt: 'Describe the task to complete.',
                      agent: 'researcher',
                      allowedTools: [],
                    }
                  : { message: 'Review and approve this workflow checkpoint.' }),
          });
    setGraph((current) => ({ ...current, nodes: [...current.nodes, added] }));
    setSelected(id);
  }
  async function action(kind: 'save' | 'publish' | 'run') {
    if (
      [...(editorRef.current?.querySelectorAll('textarea') ?? [])].some(
        (field) => !field.reportValidity(),
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      if (kind === 'save')
        saved(
          await api(
            initial ? `s2a/${initial.id}` : 's2a',
            s2aRecordSchema,
            {
              name,
              description,
              graph: s2aGraphSchema.parse(graph),
              ...(initial ? { expectedRevision: initial.revision } : { projectId }),
            },
            initial ? 'PUT' : 'POST',
          ),
        );
      else if (kind === 'publish' && initial)
        saved(
          await api(`s2a/${initial.id}/publish`, s2aRecordSchema, { revision: initial.revision }),
        );
      else if (initial?.publishedRevision) {
        const parsedInput = z.record(z.string(), z.json()).parse(input);
        if (
          pendingRun.current &&
          (JSON.stringify(pendingRun.current.input) !== JSON.stringify(parsedInput) ||
            pendingRun.current.revision !== initial.publishedRevision)
        ) {
          throw new Error('Retry the unchanged run input first to resolve the previous request.');
        }
        pendingRun.current ??= {
          requestId: crypto.randomUUID(),
          input: parsedInput,
          revision: initial.publishedRevision,
        };
        const mission = await api(`s2a/${initial.id}/run`, missionSchema, pendingRun.current);
        pendingRun.current = null;
        setMissionId(mission.id);
        await history.refetch();
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500)
        pendingRun.current = null;
      setError(
        cause instanceof z.ZodError
          ? 'Check the workflow connections and input JSON.'
          : pendingRun.current
            ? 'The run request is unresolved. Keep the input unchanged and retry; the same request will be recovered without creating another run.'
            : workspaceError(cause),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="s2a-editor" ref={editorRef}>
      <div className="integration-toolbar">
        <label>
          Workflow name
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
        </label>
        <label>
          Project
          <select
            disabled={Boolean(initial)}
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={busy || !valid.success || !name.trim()}
          onClick={() => void action('save')}
        >
          Save {initial ? 'revision' : 'workflow'}
        </button>
        <button disabled={busy || dirty || !initial} onClick={() => void action('publish')}>
          Publish revision
        </button>
      </div>
      <label className="integration-description">
        Description
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={1000}
        />
      </label>
      <div className="integration-toolbar">
        {(['value', 'tool', 'agent', 'condition', 'approval'] as const).map((kind) => (
          <button key={kind} disabled={graph.nodes.length >= 50} onClick={() => add(kind)}>
            + {kind === 'value' ? 'Data' : kind[0]!.toUpperCase() + kind.slice(1)}
          </button>
        ))}
        <button
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([JSON.stringify({ name, description, graph }, null, 2)], {
                type: 'application/json',
              }),
            );
            const link = document.createElement('a');
            link.href = url;
            link.download = 's2a-workflow.json';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Export
        </button>
        <label>
          Import
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (file.size > 100_000) {
                setError('Import files must be under 100 KB.');
                return;
              }
              void file
                .text()
                .then((text) => {
                  const value = z
                    .object({
                      name: z.string().min(1).max(120),
                      description: z.string().max(1000).default(''),
                      graph: s2aGraphSchema,
                    })
                    .parse(JSON.parse(text));
                  setName(value.name);
                  setDescription(value.description);
                  setGraph(value.graph);
                  setImportVersion((version) => version + 1);
                  setSelected(value.graph.entry);
                })
                .catch(() => setError('This file is not a valid S2A workflow.'));
            }}
          />
        </label>
      </div>
      <RequestNotice message={error} />
      {!valid.success && <p role="status">{valid.error.issues[0]?.message}</p>}
      <div className="s2a-workbench">
        <div className="s2a-canvas" aria-label="Workflow canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.3}
            maxZoom={1.8}
            onNodeClick={(_event, selected) => setSelected(selected.id)}
            onNodesChange={(changes) => {
              for (const change of changes)
                if (change.type === 'position' && change.position)
                  update(change.id, { x: change.position.x, y: change.position.y });
            }}
            onConnect={(connection) => {
              if (connection.source && connection.target)
                connect(connection.source, connection.sourceHandle ?? 'next', connection.target);
            }}
            onEdgesDelete={(deleted) => {
              for (const edge of deleted) connect(edge.source, edge.sourceHandle ?? 'next', null);
            }}
            deleteKeyCode={null}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
        <aside className="integration-panel" aria-label="Node settings">
          <label>
            Selected node
            <select value={selected} onChange={(event) => setSelected(event.target.value)}>
              {graph.nodes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {node && (
            <div key={`${node.id}:${importVersion}`}>
              <label>
                Node name
                <input
                  value={node.name}
                  onChange={(event) => {
                    if (event.target.value.trim()) update(node.id, { name: event.target.value });
                  }}
                />
              </label>
              <small>
                Reference: <code>{`{{nodes.${node.id}}}`}</code>
              </small>
              {node.kind === 'value' && (
                <JsonField
                  label="Value (JSON)"
                  value={node.value}
                  onChange={(value) => update(node.id, { value: z.json().parse(value) })}
                />
              )}
              {node.kind === 'tool' && (
                <>
                  <label>
                    Executing agent
                    <select
                      value={node.agent}
                      onChange={(event) =>
                        update(node.id, { agent: agentRoleSchema.parse(event.target.value) })
                      }
                    >
                      {agentRoleSchema.options.map((agent) => (
                        <option key={agent} value={agent}>
                          {agent}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p>
                    The selected agent needs permission to use this tool in{' '}
                    <Link href="/agents">Agents</Link>.
                  </p>
                  <label>
                    Tool
                    <select
                      value={node.tool}
                      onChange={(event) => update(node.id, { tool: event.target.value })}
                    >
                      {tools
                        .filter((item) => !item.name.startsWith('s2a.'))
                        .map((tool) => (
                          <option key={tool.name} value={tool.name}>
                            {tool.name} · {tool.effect}
                          </option>
                        ))}
                    </select>
                  </label>
                  <JsonField
                    label="Arguments (JSON)"
                    value={node.args}
                    onChange={(args) =>
                      update(node.id, { args: z.record(z.string(), z.json()).parse(args) })
                    }
                  />
                  <details>
                    <summary>Tool input schema</summary>
                    <pre>
                      {JSON.stringify(
                        tools.find((tool) => tool.name === node.tool)?.inputSchema,
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </>
              )}
              {node.kind === 'agent' && (
                <>
                  <label>
                    Agent
                    <select
                      value={node.agent}
                      onChange={(event) =>
                        update(node.id, {
                          agent: agentRoleSchema.parse(event.target.value),
                        })
                      }
                    >
                      {agentRoleSchema.options.map((agent) => (
                        <option key={agent} value={agent}>
                          {agent}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Task
                    <textarea
                      rows={5}
                      value={node.prompt}
                      onChange={(event) => {
                        if (event.target.value.trim())
                          update(node.id, { prompt: event.target.value });
                      }}
                    />
                  </label>
                  <label>
                    Allowed tools
                    <select
                      multiple
                      value={node.allowedTools}
                      onChange={(event) =>
                        update(node.id, {
                          allowedTools: [...event.target.selectedOptions].map(
                            (option) => option.value,
                          ),
                        })
                      }
                    >
                      {tools
                        .filter((tool) => !tool.name.startsWith('s2a.'))
                        .map((tool) => (
                          <option key={tool.name} value={tool.name}>
                            {tool.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </>
              )}
              {node.kind === 'condition' && (
                <>
                  <JsonField
                    label="Left value (JSON)"
                    value={node.left}
                    onChange={(left) => update(node.id, { left: z.json().parse(left) })}
                  />
                  <label>
                    Comparison
                    <select
                      value={node.operator}
                      onChange={(event) =>
                        update(node.id, {
                          operator: z
                            .enum(['equals', 'not-equals', 'contains', 'exists'])
                            .parse(event.target.value),
                        })
                      }
                    >
                      {['equals', 'not-equals', 'contains', 'exists'].map((op) => (
                        <option key={op}>{op}</option>
                      ))}
                    </select>
                  </label>
                  <JsonField
                    label="Right value (JSON)"
                    value={node.right}
                    onChange={(right) => update(node.id, { right: z.json().parse(right) })}
                  />
                </>
              )}
              {node.kind === 'approval' && (
                <label>
                  Approval message
                  <textarea
                    value={node.message}
                    onChange={(event) => {
                      if (event.target.value) update(node.id, { message: event.target.value });
                    }}
                  />
                </label>
              )}
              {nextTargets(node).map(([handle, target]) => (
                <label key={handle}>
                  {handle === 'next' ? 'Next node' : `If ${handle}`}
                  <select
                    value={target ?? ''}
                    onChange={(event) => connect(node.id, handle, event.target.value || null)}
                  >
                    <option value="">Finish workflow</option>
                    {graph.nodes
                      .filter((item) => item.id !== node.id)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
              <button onClick={() => setGraph((current) => ({ ...current, entry: node.id }))}>
                Set as start
              </button>
              <button
                disabled={graph.nodes.length === 1}
                onClick={() => {
                  const remaining = graph.nodes
                    .filter((item) => item.id !== node.id)
                    .map((item) =>
                      item.kind === 'condition'
                        ? {
                            ...item,
                            yes: item.yes === node.id ? null : item.yes,
                            no: item.no === node.id ? null : item.no,
                          }
                        : { ...item, next: item.next === node.id ? null : item.next },
                    );
                  setGraph({
                    entry: graph.entry === node.id ? remaining[0]!.id : graph.entry,
                    nodes: remaining,
                  });
                  setSelected(remaining[0]!.id);
                }}
              >
                Remove node
              </button>
            </div>
          )}
          <p>
            Use <code>{'{{input.field}}'}</code> or a node reference to map data. Connect every node
            before saving. Actions follow your approval policies.
          </p>
        </aside>
      </div>
      <div className="integration-run">
        <JsonField label="Run input (JSON object)" value={input} onChange={setInput} />
        <div>
          <p>
            {initial?.publishedRevision
              ? `Published revision ${initial.publishedRevision}`
              : 'Save and publish a revision to run it.'}
            {dirty ? ' · Unsaved changes' : ''}
          </p>
          <button
            disabled={busy || dirty || !initial?.publishedRevision}
            onClick={() => void action('run')}
          >
            Run workflow
          </button>
          {missionId && (
            <p>
              <Link href={`/missions/${missionId}`}>Open running mission →</Link>
            </p>
          )}
        </div>
      </div>
      {initial?.publishedRevision && <WorkflowSchedule workflowId={initial.id} />}
      <h2>Run history</h2>
      <RequestNotice error={history.error} />
      <div className="integration-table">
        <table>
          <thead>
            <tr>
              <th>Revision</th>
              <th>Status</th>
              <th>Steps</th>
              <th>Cost</th>
              <th>Mission</th>
            </tr>
          </thead>
          <tbody>
            {history.data?.map((item) => (
              <tr key={item.run.id}>
                <td>{item.revision}</td>
                <td>
                  <RunStatus status={item.run.status} />
                </td>
                <td>{item.run.step}</td>
                <td>${item.run.costUsd.toFixed(4)}</td>
                <td>
                  <Link href={`/missions/${item.missionId}`}>View run</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WorkflowSchedule({ workflowId }: { workflowId: string }) {
  const schedule = useWorkspaceResource(
    `s2a/${workflowId}/schedule`,
    s2aScheduleSchema.nullable(),
    true,
    false,
  );
  return (
    <details className="integration-panel">
      <summary>Run on a schedule</summary>
      <RequestNotice error={schedule.error} />
      {schedule.data !== undefined && (
        <ScheduleForm
          key={schedule.data?.version ?? 0}
          workflowId={workflowId}
          initial={schedule.data}
          refresh={() => schedule.refetch()}
        />
      )}
    </details>
  );
}
function ScheduleForm({
  workflowId,
  initial,
  refresh,
}: {
  workflowId: string;
  initial: z.infer<typeof s2aScheduleSchema> | null;
  refresh: () => Promise<unknown>;
}) {
  const [expression, setExpression] = useState(initial?.expression ?? '0 9 * * *');
  const [timezone, setTimezone] = useState(
    initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [input, setInput] = useState<unknown>(initial?.input ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        void api(
          `s2a/${workflowId}/schedule`,
          s2aScheduleSchema,
          { version: initial?.version ?? 0, expression, timezone, enabled, input },
          'PUT',
        )
          .then(refresh)
          .catch((cause: unknown) => setError(workspaceError(cause)))
          .finally(() => setBusy(false));
      }}
    >
      <p>
        Scheduled runs use the published revision. After downtime, one missed occurrence is
        recovered; earlier missed occurrences are skipped.
      </p>
      <div className="integration-toolbar">
        <label>
          Cron expression
          <input
            required
            value={expression}
            onChange={(event) => setExpression(event.target.value)}
          />
        </label>
        <label>
          Timezone
          <input required value={timezone} onChange={(event) => setTimezone(event.target.value)} />
        </label>
      </div>
      <JsonField
        label="Scheduled input (JSON object)"
        value={input}
        onChange={(value) => setInput(z.record(z.string(), z.json()).parse(value))}
      />
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Enable schedule
      </label>
      <button disabled={busy}>Save schedule</button>
      {initial?.enabled && <p>Next run: {new Date(initial.nextRunAt).toLocaleString()}</p>}
      <RequestNotice message={error} />
    </form>
  );
}
