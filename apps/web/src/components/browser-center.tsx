'use client';
import '../lib/validation';
import { useState } from 'react';
import { z } from 'zod';
import {
  browserProfileSchema,
  browserSessionSchema,
  browserProfileInputSchema,
} from '@sazuz/core/browser';
import { projectSchema } from '@sazuz/core/work';
import { api } from '../lib/api';
import { useWorkspaceResource, useWorkspaceSession, workspaceError } from '../lib/use-workspace';
import { WorkPageLayout } from './work-page';
import { WorkspaceLoading, WorkspaceSectionNav } from './workspace-section-nav';
import { LocalTime } from './durable-shared';
import { BrowserLive } from './browser-live';
import { missionSchema } from '@sazuz/core/missions';

const profileList = z.array(browserProfileSchema),
  sessionList = z.array(browserSessionSchema),
  projectList = z.array(projectSchema);
const secretsSchema = z.array(z.object({ reference: z.string(), name: z.string() }));
type Profile = z.infer<typeof browserProfileSchema>;
function ProfileCard({
  profile,
  secrets,
  change,
  busy,
  start,
}: {
  profile: Profile;
  secrets: z.infer<typeof secretsSchema>;
  change: (
    profile: Profile,
    action: 'save' | 'sign-out' | 'wipe',
    value?: { name: string; secretRefs: string[]; expiresAt: string | null },
  ) => Promise<void>;
  busy: boolean;
  start: (profile: Profile, goal: string) => Promise<void>;
}) {
  const [name, setName] = useState(profile.name),
    [refs, setRefs] = useState(profile.secretRefs),
    [expires, setExpires] = useState(profile.expiresAt?.slice(0, 16) ?? '');
  const [goal, setGoal] = useState('');
  return (
    <article className="durable-card">
      <h3>{profile.name}</h3>
      <p>
        {profile.site} · {profile.agentId} ·{' '}
        {profile.hasSavedState ? 'Encrypted session saved' : 'No saved login'}
      </p>
      <details>
        <summary>Start an Operator mission</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (goal.trim()) void start(profile, goal.trim());
          }}
        >
          <label className="setup-field">
            What should the agent do?
            <textarea
              required
              maxLength={7000}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
            />
          </label>
          <button disabled={busy}>Start mission</button>
        </form>
      </details>
      <details>
        <summary>Profile settings and secret grants</summary>
        <label className="setup-field">
          Name
          <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="setup-field">
          Expiry (UTC, optional)
          <input
            type="datetime-local"
            value={expires}
            onChange={(event) => setExpires(event.target.value)}
          />
        </label>
        <fieldset>
          <legend>Secrets available on this site</legend>
          {secrets.map((secret) => (
            <label className="setup-check" key={secret.reference}>
              <input
                type="checkbox"
                checked={refs.includes(secret.reference)}
                onChange={(event) =>
                  setRefs(
                    event.target.checked
                      ? [...refs, secret.reference]
                      : refs.filter((ref) => ref !== secret.reference),
                  )
                }
              />
              {secret.name}
            </label>
          ))}
        </fieldset>
        <p>
          Changing these settings closes existing sessions. Login, 2FA and CAPTCHA use human
          control.
        </p>
        <button
          disabled={busy || !name.trim()}
          onClick={() =>
            void change(profile, 'save', {
              name,
              secretRefs: refs,
              expiresAt: expires ? new Date(`${expires}Z`).toISOString() : null,
            })
          }
        >
          Save profile
        </button>
      </details>
      <div className="knowledge-actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void change(profile, 'sign-out')}
        >
          Sign out
        </button>
        <button
          className="secondary operation-danger"
          disabled={busy}
          onClick={() => void change(profile, 'wipe')}
        >
          Wipe profile
        </button>
      </div>
    </article>
  );
}
export function BrowserCenter() {
  const auth = useWorkspaceSession();
  const profiles = useWorkspaceResource('browser/profiles', profileList, auth.ready),
    sessions = useWorkspaceResource('browser/sessions', sessionList, auth.ready),
    projects = useWorkspaceResource('projects', projectList, auth.ready, false),
    secrets = useWorkspaceResource('vault/secrets', secretsSchema, auth.ready, false);
  const [projectId, setProjectId] = useState(''),
    [name, setName] = useState(''),
    [site, setSite] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [selected, setSelected] = useState('');
  async function act(task: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    try {
      await task();
      setNotice(message);
      await profiles.refetch();
      await sessions.refetch();
    } catch (error) {
      setError(workspaceError(error));
    } finally {
      setBusy(false);
    }
  }
  async function change(
    profile: Profile,
    action: 'save' | 'sign-out' | 'wipe',
    value?: { name: string; secretRefs: string[]; expiresAt: string | null },
  ) {
    await act(
      () =>
        api(
          `browser/profiles/${profile.id}${action === 'sign-out' ? '/sign-out' : ''}`,
          browserProfileSchema,
          { version: profile.version, ...(value ?? {}) },
          action === 'save' ? 'PUT' : action === 'wipe' ? 'DELETE' : 'POST',
        ),
      action === 'save'
        ? 'Profile updated.'
        : action === 'wipe'
          ? 'Profile wiped. Its sessions and secret grants are revoked.'
          : 'Signed out. Saved cookies and storage were removed.',
    );
  }
  const failure =
    error ||
    (profiles.error || sessions.error || projects.error || auth.error
      ? workspaceError(profiles.error || sessions.error || projects.error || auth.error)
      : '');
  return (
    <WorkPageLayout
      current="Browser"
      title="Browser"
      description="Site profiles and browser sessions for your agents."
    >
      <WorkspaceSectionNav
        label="Browser sections"
        sections={[
          { id: 'browser-create', label: 'New profile' },
          { id: 'browser-profiles', label: 'Site profiles' },
          { id: 'browser-sessions', label: 'Sessions' },
        ]}
      />
      {auth.loading || (auth.ready && profiles.isPending) ? (
        <WorkspaceLoading>Loading browser profiles…</WorkspaceLoading>
      ) : null}
      {failure && (
        <p role="alert" className="setup-error">
          {failure}
        </p>
      )}
      {notice && (
        <p role="status" className="setup-notice">
          {notice}
        </p>
      )}
      <section className="durable-card operation-section" id="browser-create">
        <h2>New site profile</h2>
        <p>
          Add this site’s domain under <a href="/settings">Settings → Security → Agent domains</a>{' '}
          for Operator. Site state is encrypted in your vault.
        </p>
        <form
          className="work-form"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = browserProfileInputSchema.safeParse({
              projectId: projectId || projects.data?.[0]?.id,
              name,
              site,
              agentId: 'operator',
            });
            if (!parsed.success) {
              setError('Choose a project, name and HTTPS site origin without a path.');
              return;
            }
            void act(async () => {
              await api('browser/profiles', browserProfileSchema, parsed.data);
              setName('');
              setSite('');
            }, 'Profile created. Start an Operator mission from its card.');
          }}
        >
          <label className="setup-field">
            Project
            <select
              value={projectId || projects.data?.[0]?.id || ''}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {projects.data?.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="setup-field">
            Profile name
            <input
              required
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="setup-field">
            HTTPS site
            <input
              required
              type="url"
              placeholder="https://example.com"
              value={site}
              onChange={(event) => setSite(event.target.value)}
            />
          </label>
          <button disabled={busy || !auth.ready || !projects.data?.length}>Create profile</button>
        </form>
      </section>
      <section
        className="operation-section browser-profile-list"
        aria-label="Site profiles"
        id="browser-profiles"
      >
        <h2>Site profiles</h2>
        {profiles.data
          ?.filter((profile) => !profile.retired)
          .map((profile) => (
            <ProfileCard
              key={`${profile.id}:${profile.version}`}
              profile={profile}
              secrets={secrets.data ?? []}
              busy={busy}
              change={change}
              start={(profile, goal) =>
                act(
                  () =>
                    api('missions', missionSchema, {
                      projectId: profile.projectId,
                      agent: 'operator',
                      requestId: crypto.randomUUID(),
                      goal: `${goal}\nUse the authorized browser profile ${profile.id}.`,
                    }),
                  'Mission started. Follow it in Missions or watch its browser session below.',
                )
              }
            />
          ))}
        {profiles.data?.every((profile) => profile.retired) && <p>No site profiles yet.</p>}
      </section>
      <section className="operation-section" aria-label="Browser sessions" id="browser-sessions">
        <h2>Sessions</h2>
        {sessions.data?.length === 0 && (
          <p>Start an Operator mission from a site profile to open a browser session.</p>
        )}
        {sessions.data?.map((session) => (
          <article className="durable-card" key={session.id}>
            <h3>{session.origin || 'New browser session'}</h3>
            <p>
              {session.status} ·{' '}
              {session.control === 'human' ? 'Waiting for human control' : 'Agent control'} ·
              expires <LocalTime value={session.expiresAt} />
            </p>
            {session.sensitive && <p>Sensitive session: images are withheld from models.</p>}
            {session.status === 'active' && (
              <button onClick={() => setSelected(session.id)}>View session</button>
            )}
          </article>
        ))}
      </section>
      {sessions.data
        ?.filter((session) => session.id === selected && session.status === 'active')
        .map((session) => (
          <BrowserLive key={session.id} initial={session} />
        ))}
    </WorkPageLayout>
  );
}
