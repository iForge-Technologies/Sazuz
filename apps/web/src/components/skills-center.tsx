'use client';
import '../lib/validation';
import { useState } from 'react';
import { z } from 'zod';
import { skillSummarySchema, skillVersionSchema, type SkillVersion } from '@sazuz/core/skills';
import { api } from '../lib/api';
import { useWorkspaceResource, useWorkspaceSession, workspaceError } from '../lib/use-workspace';
import { WorkPageLayout } from './work-page';
import { WorkspaceLoading, WorkspaceSectionNav } from './workspace-section-nav';
import { StyleProfileEditor } from './style-profile-editor';
import { LearnedSkillsCenter } from './learned-skills-center';
import { LearnedReplayPanel } from './learned-replay-panel';
import { SkillProposalsPanel } from './skill-proposals-panel';

const listSchema = z.array(skillSummarySchema);
const historySchema = z.array(
  z.strictObject({ revision: z.number().int(), sha256: z.string(), createdAt: z.iso.datetime() }),
);
const starter = `---\nname: my-skill\ndescription: Describe when this skill should be selected.\nversion: 1.0.0\ninputs:\n  type: object\n  properties: {}\n  additionalProperties: false\ntools: []\npermissions: []\n---\n# My skill\n\nWrite clear steps here. Tool permissions still come from the Policy Engine.\n`;

export function SkillsCenter() {
  const session = useWorkspaceSession();
  const skills = useWorkspaceResource('skills', listSchema, session.ready);
  const [selected, setSelected] = useState<SkillVersion | null>(null),
    [historical, setHistorical] = useState<SkillVersion | null>(null);
  const [markdown, setMarkdown] = useState(starter),
    [enabled, setEnabled] = useState(true),
    [privateOnly, setPrivateOnly] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const history = useWorkspaceResource(
    `skills/${selected?.id ?? 'none'}/versions`,
    historySchema,
    session.ready && !!selected,
    false,
  );
  async function act(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  function edit(value: SkillVersion | null) {
    setSelected(value);
    setHistorical(null);
    setMarkdown(value?.markdown ?? starter);
    setEnabled(value?.enabled ?? true);
    setPrivateOnly(value?.privateOnly ?? false);
  }
  return (
    <WorkPageLayout
      current="Skills"
      title="Skills"
      description="Reusable instructions, loaded only when selected. Tool permissions continue to follow your policy."
    >
      <WorkspaceSectionNav
        label="Skill sections"
        sections={[
          { id: 'skill-library', label: 'Library' },
          { id: 'learned-skills', label: 'Teach by watching' },
          { id: 'skill-proposals', label: 'Suggestions' },
          { id: 'skill-editor', label: 'Editor' },
        ]}
      />
      {session.loading || (session.ready && skills.isPending) ? (
        <WorkspaceLoading>Loading skills…</WorkspaceLoading>
      ) : null}
      {(error || session.error || skills.error || history.error) && (
        <p role="alert" className="setup-error">
          {error || workspaceError(session.error || skills.error || history.error)}
        </p>
      )}
      {notice && (
        <p role="status" className="setup-notice">
          {notice}
        </p>
      )}
      <section className="durable-card operation-section" id="skill-library">
        <h2>Skill library</h2>
        <p>
          The default model prompt contains names and descriptions. Selecting a skill loads its
          complete instructions and records the revision and hash in the mission.
        </p>
        <button className="secondary" disabled={busy} onClick={() => edit(null)}>
          New skill
        </button>
        <ul className="operation-records">
          {skills.data?.map((skill) => (
            <li key={skill.id}>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () => edit(await api(`skills/${skill.id}`, skillVersionSchema)))
                }
              >
                {skill.name}
              </button>{' '}
              · {skill.source} · revision {skill.revision} ·{' '}
              {skill.enabled ? 'enabled' : 'disabled'}
              <p>{skill.description}</p>
            </li>
          ))}
        </ul>
      </section>
      <LearnedSkillsCenter ready={session.ready} onSaved={skills.refetch} />
      <SkillProposalsPanel
        ready={session.ready}
        onSaved={skills.refetch}
        onSelect={async (id) => {
          await act(async () => edit(await api(`skills/${id}`, skillVersionSchema)));
        }}
      />
      {selected?.source === 'learned' && (
        <LearnedReplayPanel
          key={`${selected.id}:${selected.revision}`}
          skillId={selected.id}
          revision={selected.revision}
          onSaved={async () => {
            edit(await api(`skills/${selected.id}`, skillVersionSchema));
            await skills.refetch();
          }}
        />
      )}
      <section
        className="durable-card operation-section"
        aria-label="Skill editor"
        id="skill-editor"
      >
        <h2>{selected ? selected.name : 'Create a skill'}</h2>
        <form
          className="work-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const value = await api(
                selected ? `skills/${selected.id}` : 'skills',
                skillVersionSchema,
                { markdown, expectedRevision: selected?.revision ?? 0, enabled, privateOnly },
                selected ? 'PUT' : 'POST',
              );
              edit(value);
              await skills.refetch();
              if (selected) await history.refetch();
              setNotice(
                `Saved revision ${value.revision}. Future selections can load this revision.`,
              );
            });
          }}
        >
          <label className="setup-field">
            SKILL.md
            <textarea
              className="skill-source-editor"
              rows={18}
              required
              maxLength={24000}
              readOnly={selected?.source === 'builtin' || selected?.source === 'learned'}
              value={markdown}
              onChange={(event) => setMarkdown(event.target.value)}
              spellCheck={false}
            />
          </label>
          <p>
            Keep the name stable after creation. Learned browser programs use their dedicated review
            controls. Exported scripts are for inspection.
          </p>
          <label>
            <input
              type="checkbox"
              disabled={selected?.source === 'builtin'}
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />{' '}
            Available for selection
          </label>
          <label>
            <input
              type="checkbox"
              disabled={selected?.source === 'builtin'}
              checked={privateOnly}
              onChange={(event) => setPrivateOnly(event.target.checked)}
            />{' '}
            Keep the full instructions on local models
          </label>
          <p>Names and descriptions remain in the skill index. Store credentials in the vault.</p>
          {selected?.source !== 'builtin' && selected?.source !== 'learned' && (
            <button disabled={busy || !session.ready || !markdown.trim()}>Save skill</button>
          )}
        </form>
        {selected && (
          <>
            <p className="message-content">
              Revision {selected.revision} · SHA-256 <code>{selected.sha256}</code>
            </p>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                const text = markdown.replace(
                  /^name:.*$/m,
                  `name: custom-${selected.name.slice(0, 57)}`,
                );
                const local = privateOnly;
                edit(null);
                setPrivateOnly(local);
                setMarkdown(text);
              }}
            >
              Copy to a new skill
            </button>
            <details>
              <summary>Revision history</summary>
              <ul>
                {history.data?.map((version) => (
                  <li key={version.revision}>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () =>
                          setHistorical(
                            await api(
                              `skills/${selected.id}?revision=${version.revision}`,
                              skillVersionSchema,
                            ),
                          ),
                        )
                      }
                    >
                      View revision {version.revision}
                    </button>
                  </li>
                ))}
              </ul>
              {historical && <pre className="message-content">{historical.markdown}</pre>}
            </details>
          </>
        )}
      </section>
      <StyleProfileEditor />
    </WorkPageLayout>
  );
}
