'use client';
import '../lib/validation';
import Link from 'next/link';
import { useState } from 'react';
import { z } from 'zod';
import { settingsDocumentSchema } from '@sazuz/config/settings';
import {
  agentDefinitionSchema,
  agentSummarySchema,
  agentRevisionSchema,
  connectorPermissionSchema,
  agentRoleSchema,
  type AgentDefinition,
  type AgentRevision,
} from '@sazuz/core/agents';
import { api } from '../lib/api';
import { useWorkspaceResource, useWorkspaceSession, workspaceError } from '../lib/use-workspace';
import { WorkPageLayout } from './work-page';
import { WorkspaceLoading } from './workspace-section-nav';

export function AgentCenter({ id }: { id?: string }) {
  const session = useWorkspaceSession();
  const team = useWorkspaceResource('agents', z.array(agentSummarySchema), session.ready);
  const selected = useWorkspaceResource(
    'agents/' + (id ?? 'cos'),
    agentRevisionSchema,
    session.ready && !!id,
    false,
  );
  return (
    <WorkPageLayout
      current="Agents"
      title={selected.data?.definition.name ?? 'Agents'}
      description="Choose who does the work, their instructions and the accounts they may use."
    >
      {(session.error || team.error || selected.error) && (
        <p role="alert" className="setup-error">
          {workspaceError(session.error || team.error || selected.error)}
        </p>
      )}
      {session.loading || team.isPending ? (
        <WorkspaceLoading>Loading your team…</WorkspaceLoading>
      ) : null}
      <nav aria-label="Agent team" className="agent-team">
        {team.data?.map((agent) => (
          <Link
            key={agent.id}
            href={'/agents/' + agent.role}
            aria-current={agent.role === id ? 'page' : undefined}
          >
            <span className="agent-monogram" aria-hidden="true">
              {agent.name.charAt(0)}
            </span>
            <strong>{agent.name}</strong>
            <span>
              {agent.modelRole} · v{agent.version} · {agent.enabled ? 'Enabled' : 'Disabled'}
            </span>
            <small>{agent.accounts} account grants</small>
          </Link>
        ))}
      </nav>
      {selected.data && (
        <AgentEditor
          key={selected.data.version + ':' + selected.data.id}
          revision={selected.data}
          refresh={async () => {
            await selected.refetch();
            await team.refetch();
          }}
        />
      )}
      {!id && (
        <section className="durable-card operation-section operation-help">
          <h2>Your team</h2>
          <p>
            Open an agent to edit instructions, budgets and connector access. Every save creates a
            revision. Running tasks keep their saved instructions; removing permissions also
            restricts their next action.
          </p>
          <Link href="/settings">Manage connected accounts in Settings</Link>
        </section>
      )}
    </WorkPageLayout>
  );
}
function AgentEditor({
  revision,
  refresh,
}: {
  revision: AgentRevision;
  refresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<AgentDefinition>(revision.definition);
  const [yaml, setYaml] = useState(revision.yaml);
  const [mode, setMode] = useState<'form' | 'yaml'>('form');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const settings = useWorkspaceResource('settings', settingsDocumentSchema, true, false);
  const history = useWorkspaceResource(
    'agents/' + revision.id + '/versions',
    z.array(agentRevisionSchema),
    true,
    false,
  );
  const update = <K extends keyof AgentDefinition>(key: K, value: AgentDefinition[K]) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const formDefinition = () => ({
    ...draft,
    tools: draft.tools.map((tool) => tool.trim()).filter(Boolean),
    permissions: {
      ...draft.permissions,
      deny: draft.permissions.deny.map((tool) => tool.trim()).filter(Boolean),
    },
  });
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice('Agent revision saved.');
      await refresh();
    } catch (cause) {
      setError(workspaceError(cause, 'Check the agent definition and permissions.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="durable-card agent-editor operation-section" aria-label="Agent editor">
      <div className="work-heading">
        <h2>Edit {revision.definition.name}</h2>
        <span>Revision {revision.version}</span>
      </div>
      {error && (
        <p role="alert" className="setup-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="inline-actions" role="group" aria-label="Agent editor format">
        <button
          type="button"
          className="secondary"
          aria-pressed={mode === 'form'}
          onClick={() => setMode('form')}
        >
          Form
        </button>
        <button
          type="button"
          className="secondary"
          aria-pressed={mode === 'yaml'}
          onClick={() => {
            setYaml(JSON.stringify(formDefinition(), null, 2));
            setMode('yaml');
          }}
        >
          YAML
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void perform(() =>
            api(
              'agents/' + revision.id,
              agentRevisionSchema,
              mode === 'yaml'
                ? { expectedVersion: revision.version, yaml }
                : {
                    expectedVersion: revision.version,
                    definition: agentDefinitionSchema.parse(formDefinition()),
                  },
              'PUT',
            ),
          );
        }}
      >
        <fieldset disabled={busy}>
          {mode === 'yaml' ? (
            <label>
              Agent YAML
              <textarea
                rows={28}
                value={yaml}
                onChange={(event) => setYaml(event.target.value)}
                spellCheck={false}
                maxLength={24000}
              />
              <small>
                Saving validates this document and creates a new revision. Form edits return to
                their previous draft until saved.
              </small>
            </label>
          ) : (
            <>
              <div className="setup-grid">
                <label>
                  Name
                  <input
                    value={draft.name}
                    maxLength={120}
                    onChange={(event) => update('name', event.target.value)}
                  />
                </label>
                <label>
                  Display identity
                  <input
                    value={draft.identity.display}
                    maxLength={120}
                    onChange={(event) =>
                      update('identity', { ...draft.identity, display: event.target.value })
                    }
                  />
                </label>
                <label>
                  Model role
                  <select
                    value={draft.model.role}
                    onChange={(event) =>
                      update('model', {
                        role: agentDefinitionSchema.shape.model.shape.role.parse(
                          event.target.value,
                        ),
                      })
                    }
                  >
                    {['planner', 'executor', 'fast'].map((role) => (
                      <option key={role}>{role}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Concurrent tasks
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={draft.max_concurrent}
                    onChange={(event) => update('max_concurrent', Number(event.target.value))}
                  />
                </label>
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => update('enabled', event.target.checked)}
                />{' '}
                Enabled
              </label>
              <label>
                Description
                <input
                  value={draft.description}
                  maxLength={500}
                  onChange={(event) => update('description', event.target.value)}
                />
              </label>
              <label>
                Instructions
                <textarea
                  value={draft.instructions}
                  rows={8}
                  maxLength={12000}
                  onChange={(event) => update('instructions', event.target.value)}
                />
              </label>
              <div className="setup-grid">
                <label>
                  Allowed tools (one per line)
                  <textarea
                    value={draft.tools.join('\n')}
                    rows={5}
                    onChange={(event) => update('tools', event.target.value.split('\n'))}
                  />
                </label>
                <label>
                  Denied tools (one per line)
                  <textarea
                    value={draft.permissions.deny.join('\n')}
                    rows={5}
                    onChange={(event) =>
                      update('permissions', {
                        ...draft.permissions,
                        deny: event.target.value.split('\n'),
                      })
                    }
                  />
                </label>
              </div>
              <p>
                Use exact tool names or a prefix such as files.*. Policy, account grants and current
                revocations always apply.
              </p>
              <fieldset>
                <legend>Task budgets</legend>
                <div className="setup-grid">
                  {(['max_steps', 'max_cost_usd', 'max_wall_time_seconds'] as const).map((key) => (
                    <label key={key}>
                      {key === 'max_steps'
                        ? 'Steps'
                        : key === 'max_cost_usd'
                          ? 'Cost (USD)'
                          : 'Wall time (seconds)'}
                      <input
                        type="number"
                        min={key === 'max_cost_usd' ? 0 : 1}
                        step={key === 'max_cost_usd' ? '0.01' : 1}
                        value={draft.budget[key]}
                        onChange={(event) =>
                          update('budget', { ...draft.budget, [key]: Number(event.target.value) })
                        }
                      />
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>Memory and handoffs</legend>
                {(['global', 'project', 'agent'] as const).map((scope) => (
                  <label key={scope}>
                    <input
                      type="checkbox"
                      checked={draft.memory.read.includes(scope)}
                      onChange={(event) =>
                        update('memory', {
                          ...draft.memory,
                          read: event.target.checked
                            ? [...draft.memory.read, scope]
                            : draft.memory.read.filter((item) => item !== scope),
                        })
                      }
                    />
                    Read {scope} memory
                  </label>
                ))}
                <label>
                  Memory writes
                  <select
                    value={draft.memory.write}
                    onChange={(event) =>
                      update('memory', {
                        ...draft.memory,
                        write: event.target.value === 'none' ? 'none' : 'proposals',
                      })
                    }
                  >
                    <option value="proposals">Reviewed proposals</option>
                    <option value="none">None</option>
                  </select>
                </label>
                <fieldset>
                  <legend>Handoff targets</legend>
                  {agentRoleSchema.options
                    .filter((role) => role !== draft.id)
                    .map((role) => (
                      <label key={role}>
                        <input
                          type="checkbox"
                          checked={draft.handoff_to.includes(role)}
                          onChange={(event) =>
                            update(
                              'handoff_to',
                              event.target.checked
                                ? [...draft.handoff_to, role]
                                : draft.handoff_to.filter((value) => value !== role),
                            )
                          }
                        />
                        {role}
                      </label>
                    ))}
                </fieldset>
              </fieldset>
              <fieldset>
                <legend>Connector account permissions</legend>
                <p>
                  Choose accounts and individual operations. Adding an account in Settings does not
                  grant it to this agent.
                </p>
                {settings.error && <p role="alert">{workspaceError(settings.error)}</p>}
                {settings.data?.connectors.value.accounts.map((account) => (
                  <fieldset key={account.id}>
                    <legend>
                      {account.name} · {account.provider ?? account.kind}
                    </legend>
                    {connectorPermissionSchema.options
                      .filter((permission) =>
                        permission.startsWith(
                          account.kind === 'email'
                            ? 'email:'
                            : account.kind === 'calendar'
                              ? 'calendar:'
                              : 'github:',
                        ),
                      )
                      .map((permission) => (
                        <label key={permission}>
                          <input
                            type="checkbox"
                            disabled={draft.id === 'auditor'}
                            checked={draft.identity.connector_accounts.some(
                              (grant) =>
                                grant.accountId === account.id &&
                                grant.permissions.includes(permission),
                            )}
                            onChange={(event) => {
                              const prior =
                                draft.identity.connector_accounts.find(
                                  (grant) => grant.accountId === account.id,
                                )?.permissions ?? [];
                              const permissions = event.target.checked
                                ? [...prior, permission]
                                : prior.filter((value) => value !== permission);
                              update('identity', {
                                ...draft.identity,
                                connector_accounts: [
                                  ...draft.identity.connector_accounts.filter(
                                    (grant) => grant.accountId !== account.id,
                                  ),
                                  ...(permissions.length
                                    ? [{ accountId: account.id, permissions }]
                                    : []),
                                ],
                              });
                            }}
                          />
                          {permission}
                        </label>
                      ))}
                  </fieldset>
                ))}
                {settings.data?.connectors.value.accounts.length === 0 && (
                  <p>
                    No connected accounts. <Link href="/settings">Connect an account</Link> first.
                  </p>
                )}
              </fieldset>
              <label>
                Optional outbound footer
                <input
                  value={draft.identity.outbound_footer}
                  maxLength={200}
                  onChange={(event) =>
                    update('identity', { ...draft.identity, outbound_footer: event.target.value })
                  }
                />
                <small>
                  Included in drafting instructions; the reviewed outbound text remains
                  authoritative.
                </small>
              </label>
            </>
          )}
          <button type="submit" className="primary">
            {busy ? 'Saving…' : 'Save revision'}
          </button>
        </fieldset>
      </form>
      <details>
        <summary>Version history</summary>
        <p>Restore writes a new revision and validates current account permissions.</p>
        {history.data?.map((item) => (
          <article key={item.version}>
            <h3>Version {item.version}</h3>
            <p>
              {new Date(item.createdAt).toLocaleString()} · {item.sha256.slice(0, 12)}
            </p>
            <details>
              <summary>Definition</summary>
              <pre className="agent-yaml">{item.yaml}</pre>
            </details>
            <button
              type="button"
              className="secondary"
              disabled={busy || item.version === revision.version}
              onClick={() =>
                void perform(() =>
                  api('agents/' + revision.id + '/rollback', agentRevisionSchema, {
                    expectedVersion: revision.version,
                    version: item.version,
                  }),
                )
              }
            >
              Restore version {item.version}
            </button>
          </article>
        ))}
      </details>
    </section>
  );
}
