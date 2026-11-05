'use client';
import '../lib/validation';
import { useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { memorySchema, knowledgeJobSchema, type Memory } from '@sazuz/core/memory';
import { projectSchema } from '@sazuz/core/work';
import { api } from '../lib/api';
import { useWorkspaceResource, useWorkspaceSession, workspaceError } from '../lib/use-workspace';
import { WorkPageLayout } from './work-page';
import { WorkspaceSectionNav } from './workspace-section-nav';
import { agentLabels, LocalTime } from './durable-shared';

const memoriesSchema = z.array(memorySchema);
const projectsSchema = z.array(projectSchema);
const jobsSchema = z.array(knowledgeJobSchema);
const deletedSchema = z.strictObject({ deleted: z.number().int() });

function MemoryCard({
  memory,
  busy,
  change,
  remove,
}: {
  memory: Memory;
  busy: boolean;
  change: (memory: Memory, content: string, status: Memory['status']) => Promise<void>;
  remove: (memory: Memory) => Promise<void>;
}) {
  const [content, setContent] = useState(memory.content);
  return (
    <article className="durable-card" aria-label={`${memory.kind} memory`}>
      <header className="knowledge-card-heading">
        <strong>{memory.kind}</strong>
        <span className="work-tag">{memory.status}</span>
        <span>
          {memory.scope}
          {memory.agentId ? ` · ${agentLabels[memory.agentId]}` : ''}
        </span>
      </header>
      <label className="setup-field">
        Memory text
        <textarea
          rows={3}
          value={content}
          maxLength={4000}
          onChange={(event) => setContent(event.target.value)}
        />
      </label>
      {memory.sourceQuote && <blockquote>{memory.sourceQuote}</blockquote>}
      <details>
        <summary>Provenance and version</summary>
        <p>{memory.sourceRunId ? `Source run: ${memory.sourceRunId}` : 'Entered by you.'}</p>
        {memory.sourceMessageId && <p>Source message: {memory.sourceMessageId}</p>}
        <p>
          Version {memory.version} · Updated <LocalTime value={memory.updatedAt} />
        </p>
      </details>
      <div className="knowledge-actions">
        <button
          disabled={busy || !content.trim()}
          onClick={() => void change(memory, content, 'accepted')}
        >
          {memory.status === 'accepted' ? 'Save changes' : 'Accept memory'}
        </button>
        {memory.status === 'proposed' && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void change(memory, content, 'rejected')}
          >
            Reject
          </button>
        )}
        <button
          className="secondary operation-danger"
          disabled={busy}
          onClick={() => void remove(memory)}
        >
          Delete memory
        </button>
      </div>
    </article>
  );
}

export function MemoryCenter() {
  const session = useWorkspaceSession();
  const memories = useWorkspaceResource('memory', memoriesSchema, session.ready);
  const projects = useWorkspaceResource('projects', projectsSchema, session.ready, false);
  const jobs = useWorkspaceResource('memory/jobs', jobsSchema, session.ready);
  const [projectId, setProjectId] = useState('');
  const [scope, setScope] = useState<'global' | 'project' | 'agent'>('project');
  const [agentId, setAgentId] = useState<keyof typeof agentLabels>('cos');
  const [kind, setKind] = useState<Memory['kind']>('preference');
  const [content, setContent] = useState('');
  const [sensitivity, setSensitivity] = useState<'low' | 'private'>('low');
  const [filter, setFilter] = useState('all');
  const [forgetText, setForgetText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const selectedProject = projectId || projects.data?.[0]?.id || '';
  async function act(operation: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
      await memories.refetch();
      await jobs.refetch();
      setNotice(success);
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  const visible = (memories.data ?? []).filter(
    (memory) => filter === 'all' || memory.status === filter,
  );
  return (
    <WorkPageLayout
      current="Memory"
      title="Memory"
      description="Review what Sazuz remembers. Accepted facts and preferences are available in conversations within their scope."
    >
      <WorkspaceSectionNav
        label="Memory sections"
        sections={[
          { id: 'memory-add', label: 'Add memory' },
          { id: 'memory-review', label: 'Review & edit' },
          { id: 'memory-forget', label: 'Forget a topic' },
          { id: 'memory-jobs', label: 'Background work' },
        ]}
      />
      {(error || session.error || memories.error || jobs.error || projects.error) && (
        <p role="alert" className="setup-error">
          {error || workspaceError(session.error || memories.error || jobs.error || projects.error)}
        </p>
      )}
      {notice && (
        <p role="status" className="setup-notice">
          {notice}
        </p>
      )}
      <section className="durable-card operation-section" aria-label="Add memory" id="memory-add">
        <h2>Add a fact or preference</h2>
        <form
          className="work-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await api('memory', memorySchema, {
                scope,
                projectId: scope === 'global' ? null : selectedProject,
                agentId: scope === 'agent' ? agentId : null,
                kind,
                content,
                importance: 0.5,
                sensitivity,
              });
              setContent('');
            }, 'Memory saved. It is available to the next conversation in this scope.');
          }}
        >
          <fieldset disabled={!session.ready || busy}>
            <div className="form-columns">
              <label className="setup-field">
                Scope
                <select
                  value={scope}
                  onChange={(event) => setScope(event.target.value as typeof scope)}
                >
                  <option value="project">Project</option>
                  <option value="global">All my projects</option>
                  <option value="agent">Agent in project</option>
                </select>
              </label>
              {scope !== 'global' && (
                <label className="setup-field">
                  Project
                  <select
                    required
                    value={selectedProject}
                    onChange={(event) => setProjectId(event.target.value)}
                  >
                    <option value="" disabled>
                      Choose a project
                    </option>
                    {projects.data?.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {scope === 'agent' && (
                <label className="setup-field">
                  Agent
                  <select
                    value={agentId}
                    onChange={(event) => setAgentId(event.target.value as typeof agentId)}
                  >
                    {Object.entries(agentLabels).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="setup-field">
                Kind
                <select
                  value={kind}
                  onChange={(event) => setKind(event.target.value as typeof kind)}
                >
                  <option value="preference">Preference</option>
                  <option value="fact">Fact</option>
                  <option value="episode">Episode</option>
                </select>
              </label>
              <label className="setup-field">
                Sensitivity
                <select
                  value={sensitivity}
                  onChange={(event) => setSensitivity(event.target.value as typeof sensitivity)}
                >
                  <option value="low">Ordinary</option>
                  <option value="private">Private · local models only</option>
                </select>
              </label>
            </div>
            <label className="setup-field">
              What should Sazuz remember?
              <textarea
                required
                rows={3}
                maxLength={4000}
                value={content}
                onChange={(event) => setContent(event.target.value)}
              />
            </label>
            <button disabled={!content.trim() || (scope !== 'global' && !selectedProject)}>
              Save memory
            </button>
          </fieldset>
        </form>
      </section>
      <div className="knowledge-card-heading operation-section" id="memory-review">
        <h2>Review and edit</h2>
        <label className="setup-field">
          Show
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">All memories</option>
            <option value="proposed">Needs review</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
      </div>
      {memories.isPending && <p role="status">Loading memories…</p>}
      {!memories.isPending && !visible.length && (
        <p className="work-muted">
          No memories in this view. New proposals appear after completed missions.
        </p>
      )}
      <div className="knowledge-grid memory-records">
        {visible.map((memory) => (
          <MemoryCard
            key={`${memory.id}:${memory.version}`}
            memory={memory}
            busy={busy}
            change={(item, text, status) =>
              act(
                () =>
                  api(
                    `memory/${item.id}`,
                    memorySchema,
                    { version: item.version, content: text, importance: item.importance, status },
                    'PUT',
                  ),
                'Memory updated.',
              )
            }
            remove={(item) =>
              act(
                () => api(`memory/${item.id}`, deletedSchema, { version: item.version }, 'DELETE'),
                'Memory deleted from retrieval. Existing conversation history is preserved.',
              )
            }
          />
        ))}
      </div>
      <section className="durable-card operation-section" id="memory-forget">
        <h2>Forget a topic</h2>
        <p>
          Remove matching memories from{' '}
          {scope === 'global' ? 'global scope' : 'the selected project'}, including proposals.
          Historical conversations remain in their original threads.
        </p>
        <form
          className="work-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              () =>
                api('memory/forget', deletedSchema, {
                  projectId: scope === 'global' ? null : selectedProject,
                  text: forgetText,
                }),
              'Matching memories removed from retrieval.',
            );
          }}
        >
          <label className="setup-field">
            Text to forget
            <input
              required
              minLength={2}
              maxLength={200}
              value={forgetText}
              onChange={(event) => setForgetText(event.target.value)}
            />
          </label>
          <button
            className="secondary operation-danger"
            disabled={
              busy ||
              !session.ready ||
              forgetText.trim().length < 2 ||
              (scope !== 'global' && !selectedProject)
            }
          >
            Forget matching memories
          </button>
        </form>
      </section>
      <section className="durable-card operation-section" id="memory-jobs">
        <h2>Background work</h2>
        <p>
          Automatic acceptance is off by default. Change memory rules in{' '}
          <Link href="/settings">Settings</Link>.
        </p>
        {!jobs.data?.length && <p className="work-muted">No extraction jobs yet.</p>}
        <ul className="operation-records">
          {jobs.data?.map((job) => (
            <li key={job.id}>
              {job.kind} · {job.status} · ${job.costUsd.toFixed(4)}{' '}
              {job.errorCode && <span>({job.errorCode})</span>}
              {['blocked', 'failed'].includes(job.status) && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => api(`memory/jobs/${job.id}/retry`, knowledgeJobSchema, {}),
                      'Job queued. It may make another model call.',
                    )
                  }
                >
                  Retry job
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </WorkPageLayout>
  );
}
