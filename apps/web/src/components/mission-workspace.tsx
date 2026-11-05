'use client';
import '../lib/validation';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { projectSchema } from '@sazuz/core/work';
import {
  agentRoleSchema,
  controlSchema,
  missionDetailSchema,
  missionInputSchema,
  missionSchema,
  runSchema,
  type AgentRole,
  type RunControl,
} from '@sazuz/core/missions';
import { api } from '../lib/api';
import { useWorkspaceResource, useWorkspaceSession, workspaceError } from '../lib/use-workspace';
import { WorkPageLayout } from './work-page';
import { agentLabels, LocalTime, RequestNotice, RunStatus } from './durable-shared';
import { formatCost } from './chat-messages';
import { MissionControls } from './mission-controls';
import { MissionTimeline } from './mission-timeline';
import { MissionGraph, MissionBlackboard, MissionReply } from './mission-graph';
import { MissionReviews, ProjectReviewControl } from './mission-reviews';

const missionsSchema = z.array(missionSchema);
const projectsSchema = z.array(projectSchema);

export function MissionWorkspace({ initialId }: { initialId?: string }) {
  const session = useWorkspaceSession();
  const client = useQueryClient();
  const router = useRouter();
  const missions = useWorkspaceResource('missions', missionsSchema, session.ready);
  const projects = useWorkspaceResource('projects', projectsSchema, session.ready, false);
  const control = useWorkspaceResource('control', controlSchema, session.ready);
  const selectedId = initialId ?? missions.data?.[0]?.id ?? '';
  const detail = useWorkspaceResource(
    `missions/${selectedId}`,
    missionDetailSchema,
    session.ready && !!selectedId,
  );
  const [showCreate, setShowCreate] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [agent, setAgent] = useState<AgentRole>('cos');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const requestId = useRef<string | null>(null);
  const selectedProject = projectId || projects.data?.[0]?.id || '';
  async function create() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      requestId.current ??= crypto.randomUUID();
      const input = missionInputSchema.safeParse({
        projectId: selectedProject,
        ...(title.trim() ? { title: title.trim() } : {}),
        goal,
        agent,
        requestId: requestId.current,
      });
      if (!input.success) {
        setError('Choose a project and describe the mission you want to run.');
        return;
      }
      const mission = await api('missions', missionSchema, input.data);
      requestId.current = null;
      setTitle('');
      setGoal('');
      setShowCreate(false);
      await client.invalidateQueries({ queryKey: ['workspace', 'missions'] });
      router.push(`/missions/${mission.id}`);
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function changeRun(input: RunControl) {
    if (!detail.data) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const run = await api(`runs/${detail.data.mission.run.id}/control`, runSchema, input);
      client.setQueryData(['workspace', `missions/${selectedId}`], {
        ...detail.data,
        mission: { ...detail.data.mission, run },
      });
      await client.invalidateQueries({ queryKey: ['workspace', 'missions'] });
      setMessage(
        input.action === 'extend'
          ? 'Allowance updated. The mission is ready to continue.'
          : 'Mission status updated.',
      );
    } catch (cause) {
      setError(workspaceError(cause));
      await detail.refetch();
    } finally {
      setBusy(false);
    }
  }
  const current = detail.data?.mission;
  return (
    <WorkPageLayout
      current="Missions"
      title="Missions"
      description="Give your team a goal, follow each step, and stay in control."
      actions={
        <button
          type="button"
          disabled={!session.ready}
          aria-expanded={showCreate}
          onClick={() => setShowCreate(!showCreate)}
        >
          New mission
        </button>
      }
    >
      <RequestNotice error={session.error || missions.error || projects.error} message={error} />
      {message && (
        <p className="setup-notice" role="status">
          {message}
        </p>
      )}
      {(showCreate || missions.data?.length === 0) && session.ready && (
        <section className="durable-card mission-create" aria-label="New mission">
          <h2>What should your team do?</h2>
          {!projects.data?.length && !projects.isPending ? (
            <p>
              Create a project in <Link href="/chat">Chat</Link> before starting a mission.
            </p>
          ) : (
            <form
              className="work-form"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <fieldset disabled={busy || !projects.data?.length || control.data?.paused}>
                <label className="setup-field">
                  Project
                  <select
                    value={selectedProject}
                    onChange={(event) => {
                      setProjectId(event.target.value);
                      requestId.current = null;
                    }}
                  >
                    {projects.data?.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                        {project.privacy === 'private' ? ' · private' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="setup-field">
                  Mission title (optional)
                  <input
                    maxLength={160}
                    value={title}
                    onChange={(event) => {
                      setTitle(event.target.value);
                      requestId.current = null;
                    }}
                  />
                </label>
                <label className="setup-field">
                  Mission goal
                  <textarea
                    required
                    maxLength={16000}
                    rows={4}
                    value={goal}
                    onChange={(event) => {
                      setGoal(event.target.value);
                      requestId.current = null;
                    }}
                    placeholder="Describe the result you need and any constraints."
                  />
                </label>
                <label className="setup-field">
                  Assign to
                  <select
                    value={agent}
                    onChange={(event) => {
                      setAgent(agentRoleSchema.parse(event.target.value));
                      requestId.current = null;
                    }}
                  >
                    {agentRoleSchema.options.map((role) => (
                      <option key={role} value={role}>
                        {agentLabels[role]}
                      </option>
                    ))}
                  </select>
                  <small>
                    The Chief of Staff can plan parallel tasks and delegate to your enabled team.
                  </small>
                </label>
                <p className="work-muted">
                  Your <Link href="/settings?section=budgets">workspace budgets</Link> and the
                  project’s privacy rules apply.
                </p>
                <button>{busy ? 'Creating…' : 'Start mission'}</button>
              </fieldset>
            </form>
          )}
          {selectedProject && (
            <ProjectReviewControl key={selectedProject} projectId={selectedProject} />
          )}
        </section>
      )}
      {(!session.ready || missions.isPending) && !session.error && (
        <p role="status">Loading missions…</p>
      )}
      {missions.data && missions.data.length > 0 && (
        <div className="mission-layout">
          <nav className="mission-list" aria-label="Missions">
            {missions.data.map((mission) => (
              <Link
                key={mission.id}
                href={`/missions/${mission.id}`}
                aria-current={mission.id === selectedId ? 'page' : undefined}
              >
                <strong>{mission.title}</strong>
                <RunStatus status={mission.run.status} />
                <span>
                  {agentLabels[mission.run.agentId]} · {formatCost(mission.run.costUsd)}
                </span>
              </Link>
            ))}
          </nav>
          <section className="durable-card mission-detail" aria-label="Selected mission">
            <RequestNotice error={detail.error} />
            {detail.isPending && <p role="status">Loading mission details…</p>}
            {current && detail.data && (
              <>
                <header className="durable-heading">
                  <div>
                    <h2>{current.title}</h2>
                    <p>
                      {agentLabels[current.run.agentId]} · Updated{' '}
                      <LocalTime value={current.updatedAt} />
                    </p>
                  </div>
                  <RunStatus status={current.run.status} />
                </header>
                <p className="message-content">{current.goal}</p>
                <dl className="run-metrics">
                  <div>
                    <dt>Steps</dt>
                    <dd>
                      {current.run.step} / {current.run.limits.maxSteps}
                    </dd>
                  </div>
                  <div>
                    <dt>Cost</dt>
                    <dd>
                      {formatCost(current.run.costUsd)} /{' '}
                      {formatCost(current.run.limits.maxCostUsd)}
                    </dd>
                  </div>
                  <div>
                    <dt>Time allowance</dt>
                    <dd>{current.run.limits.maxWallTimeSeconds.toLocaleString()} seconds</dd>
                  </div>
                </dl>
                {current.run.tainted && (
                  <p className="setup-notice">
                    This run has read external content. Consequential actions require review.
                  </p>
                )}
                <MissionControls
                  key={`${current.run.id}:${current.run.status}`}
                  run={current.run}
                  disabled={busy || !!detail.error}
                  globallyPaused={control.data?.paused ?? false}
                  onControl={changeRun}
                />
                <p className="mission-links">
                  <Link href={`/chat?projectId=${current.projectId}&threadId=${current.threadId}`}>
                    Open project conversation
                  </Link>
                  <Link href={`/approvals?missionId=${current.id}`}>
                    View mission approvals (
                    {
                      detail.data.approvals.filter((approval) => approval.status === 'pending')
                        .length
                    }
                    )
                  </Link>
                </p>
                {current.run.status === 'paused' && !control.data?.paused && (
                  <MissionReply run={current.run} />
                )}
                {detail.data.graph && (
                  <MissionGraph
                    key={current.id}
                    graph={detail.data.graph}
                    globallyPaused={control.data?.paused ?? false}
                  />
                )}
                {detail.data.graph && <MissionBlackboard notes={detail.data.blackboard} />}
                <MissionReviews reviews={detail.data.reviews} />
                {!showCreate && (
                  <ProjectReviewControl key={current.projectId} projectId={current.projectId} />
                )}
                <MissionTimeline detail={detail.data} />
              </>
            )}
          </section>
        </div>
      )}
    </WorkPageLayout>
  );
}
