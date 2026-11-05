'use client';
import '../lib/validation';
import { useState } from 'react';
import { z } from 'zod';
import { projectSchema } from '@sazuz/core/work';
import { skillProposalSchema, type SkillProposal } from '@sazuz/core/proposals';
import { api } from '../lib/api';
import { useWorkspaceResource, workspaceError } from '../lib/use-workspace';

const projectsSchema = z.array(projectSchema),
  proposalsSchema = z.array(skillProposalSchema);
export function SkillProposalsPanel({
  ready,
  onSaved,
  onSelect,
}: {
  ready: boolean;
  onSaved: () => Promise<unknown>;
  onSelect: (id: string) => Promise<void>;
}) {
  const projects = useWorkspaceResource('projects', projectsSchema, ready, false);
  const [projectId, setProjectId] = useState('');
  const selectedProject = projectId || projects.data?.[0]?.id || '';
  const proposals = useWorkspaceResource(
    `skills/proposals?projectId=${selectedProject}`,
    proposalsSchema,
    ready && !!selectedProject,
  );
  return (
    <section
      className="durable-card operation-section"
      aria-label="Skills proposed from missions"
      id="skill-proposals"
    >
      <h2>Suggestions from repeated missions</h2>
      <p>
        After three successful CoS missions with closely matching plans, Sazuz can suggest reusable
        instructions. Review the source missions and edit the draft before accepting. Proposals make
        no model request and grant no tool permissions.
      </p>
      {(projects.error || proposals.error) && (
        <p role="alert">{workspaceError(projects.error || proposals.error)}</p>
      )}
      <label className="setup-field">
        Proposal project
        <select value={selectedProject} onChange={(event) => setProjectId(event.target.value)}>
          {projects.data?.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      {proposals.data?.length === 0 && (
        <p>
          No matching set of three recent successful missions has produced a proposal in this
          project.
        </p>
      )}
      {proposals.data?.map((proposal) => (
        <Proposal
          key={`${proposal.id}:${proposal.status}`}
          value={proposal}
          onSelect={onSelect}
          refresh={async () => {
            await proposals.refetch();
            await onSaved();
          }}
        />
      ))}
    </section>
  );
}
function Proposal({
  value,
  refresh,
  onSelect,
}: {
  value: SkillProposal;
  refresh: () => Promise<void>;
  onSelect: (id: string) => Promise<void>;
}) {
  const [markdown, setMarkdown] = useState(value.markdown),
    [privateOnly, setPrivateOnly] = useState(true),
    [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function decide(accept: boolean) {
    setBusy(true);
    setError('');
    try {
      await api(
        `skills/proposals/${value.id}/decision`,
        skillProposalSchema,
        accept
          ? { action: 'accept', markdown, enabled, privateOnly: privateOnly || value.privateOnly }
          : { action: 'reject' },
      );
      await refresh();
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="durable-card" aria-label="Mission skill proposal">
      <h3>Three matching mission plans</h3>
      <p>
        {value.status} · {new Date(value.createdAt).toLocaleString()}
      </p>
      {error && <p role="alert">{error}</p>}
      <ul>
        {value.sources.map((source, index) => (
          <li key={source.missionId}>
            <a href={`/missions/${source.missionId}`}>Source mission {index + 1}</a> ·{' '}
            {source.planRevision === null
              ? 'sequential plan'
              : `graph revision ${source.planRevision}`}
          </li>
        ))}
      </ul>
      {value.status === 'proposed' ? (
        <form
          className="work-form"
          onSubmit={(event) => {
            event.preventDefault();
            void decide(true);
          }}
        >
          <label className="setup-field">
            Proposed SKILL.md
            <textarea
              rows={14}
              minLength={1}
              maxLength={24000}
              required
              disabled={busy}
              value={markdown}
              onChange={(event) => setMarkdown(event.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(event) => setEnabled(event.target.checked)}
            />{' '}
            Enable the accepted skill
          </label>
          <label>
            <input
              type="checkbox"
              checked={privateOnly || value.privateOnly}
              disabled={busy || value.privateOnly}
              onChange={(event) => setPrivateOnly(event.target.checked)}
            />{' '}
            Use local models for this skill
            {value.privateOnly ? ' (required by source privacy)' : ''}
          </label>
          <div className="knowledge-actions">
            <button disabled={busy || !markdown.trim()}>Accept reviewed skill</button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void decide(false)}
            >
              Reject suggestion
            </button>
          </div>
        </form>
      ) : (
        <details>
          <summary>Reviewed instructions</summary>
          <pre className="message-content">{value.markdown}</pre>
        </details>
      )}
      {value.skillId && (
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            void onSelect(value.skillId!).catch((cause: unknown) =>
              setError(workspaceError(cause)),
            );
          }}
        >
          Open accepted skill
        </button>
      )}
      {value.status === 'rejected' && (
        <p>This pattern remains suppressed when similar missions finish.</p>
      )}
    </article>
  );
}
