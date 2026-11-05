'use client';
import '../lib/validation';
import { useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { settingsDocumentSchema } from '@sazuz/config/settings';
import { projectSchema } from '@sazuz/core/work';
import {
  recipeInstallationSchema,
  recipeTemplateSchema,
  type RecipeInstallation,
  type RecipeTemplate,
} from '@sazuz/core/recipes';
import { api, secretListSchema } from '../lib/api';
import { useWorkspaceResource, useWorkspaceSession, workspaceError } from '../lib/use-workspace';
import { WorkPageLayout } from './work-page';
import { agentLabels, LocalTime } from './durable-shared';

const templatesSchema = z.array(recipeTemplateSchema),
  installationsSchema = z.array(recipeInstallationSchema),
  projectsSchema = z.array(projectSchema);
const modeLabels = {
  manual: 'Run once',
  cron: 'Cron schedule',
  imap: 'New email (IMAP)',
  rss: 'New RSS item',
  webhook: 'Authenticated webhook',
} as const;
export function RecipeCenter() {
  const session = useWorkspaceSession();
  const templates = useWorkspaceResource('recipes', templatesSchema, session.ready, false);
  const projects = useWorkspaceResource('projects', projectsSchema, session.ready, false);
  const settings = useWorkspaceResource('settings', settingsDocumentSchema, session.ready, false);
  const secrets = useWorkspaceResource('vault/secrets', secretListSchema, session.ready, false);
  const installed = useWorkspaceResource(
    'recipes/installations',
    installationsSchema,
    session.ready,
    false,
  );
  const [selected, setSelected] = useState<RecipeTemplate | null>(null);
  const [search, setSearch] = useState('');
  const [project, setProject] = useState(''),
    [values, setValues] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<keyof typeof modeLabels>('manual'),
    [expression, setExpression] = useState(''),
    [timezone, setTimezone] = useState('UTC');
  const [connectorId, setConnectorId] = useState(''),
    [mailbox, setMailbox] = useState('INBOX');
  const [feedUrl, setFeedUrl] = useState(''),
    [hookSecret, setHookSecret] = useState('');
  const [preview, setPreview] = useState<RecipeInstallation | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  function choose(template: RecipeTemplate) {
    setSelected(template);
    setValues(Object.fromEntries(template.fields.map((field) => [field.key, field.default])));
    setMode(template.modes[0]!);
    setExpression(template.defaultCron);
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    setPreview(null);
    setNotice('');
  }
  const imapAccounts =
    settings.data?.connectors.value.accounts.filter(
      (account) => account.provider === 'imap-smtp',
    ) ?? [];
  return (
    <WorkPageLayout
      current="Recipes"
      title="Recipes"
      description="Choose a template, customize its inputs, then review the exact work before starting it."
    >
      {(error ||
        session.error ||
        templates.error ||
        projects.error ||
        settings.error ||
        installed.error) && (
        <p role="alert" className="setup-error">
          {error ||
            workspaceError(
              session.error ||
                templates.error ||
                projects.error ||
                settings.error ||
                installed.error,
            )}
        </p>
      )}
      {notice && (
        <p role="status" className="setup-notice">
          {notice}
        </p>
      )}
      <section className="durable-card operation-section" aria-label="Recipe catalogue">
        <h2>Ready to customize</h2>
        <label className="setup-field operation-filter">
          Find a recipe
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name or task"
          />
        </label>
        <ul className="recipe-catalogue">
          {templates.data
            ?.filter((template) =>
              `${template.title} ${template.description}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((template) => (
              <li key={template.id}>
                <button
                  className="secondary"
                  disabled={busy}
                  aria-pressed={selected?.id === template.id}
                  onClick={() => choose(template)}
                >
                  {template.title}
                </button>
                <p>{template.description}</p>
              </li>
            ))}
        </ul>
        {templates.isPending && <p role="status">Loading recipes…</p>}
      </section>
      {selected && (
        <section className="durable-card operation-section" aria-label="Customize recipe">
          <h2>Customize {selected.title}</h2>
          <ul>
            {selected.assignments.map((item, index) => (
              <li key={index}>
                {agentLabels[item.agent]}: {item.task}
              </li>
            ))}
          </ul>
          <h3>Before you start</h3>
          <ul>
            {selected.prerequisites.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <h3>Available behavior</h3>
          {selected.eventContract && <p>Event input: {selected.eventContract}</p>}
          <ul>
            {selected.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <form
            className="work-form"
            onChange={() => setPreview(null)}
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                const schedule =
                  mode === 'manual'
                    ? { kind: mode }
                    : mode === 'cron'
                      ? { kind: mode, expression, timezone }
                      : mode === 'imap'
                        ? { kind: mode, connectorId, mailbox, pollIntervalSeconds: 300 }
                        : mode === 'rss'
                          ? { kind: mode, url: feedUrl, pollIntervalSeconds: 300 }
                          : { kind: mode, secretRef: hookSecret };
                setPreview(
                  await api('recipes/preview', recipeInstallationSchema, {
                    recipeId: selected.id,
                    requestId: crypto.randomUUID(),
                    projectId: project || projects.data?.[0]?.id,
                    values,
                    schedule,
                  }),
                );
                await installed.refetch();
              });
            }}
          >
            <fieldset disabled={busy}>
              <label className="setup-field">
                Project
                <select
                  required
                  value={project || projects.data?.[0]?.id || ''}
                  onChange={(event) => setProject(event.target.value)}
                >
                  {!projects.data?.length && (
                    <option value="">Create a project in Chat first</option>
                  )}
                  {projects.data?.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              {selected.fields.map((field) => (
                <label className="setup-field" key={field.key}>
                  {field.label}
                  <textarea
                    required={field.required}
                    maxLength={4000}
                    rows={3}
                    value={values[field.key] ?? ''}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                  />
                  <small>{field.help}</small>
                </label>
              ))}
              <label className="setup-field">
                Run when
                <select
                  value={mode}
                  onChange={(event) => setMode(event.target.value as keyof typeof modeLabels)}
                >
                  {selected.modes.map((kind) => (
                    <option key={kind} value={kind}>
                      {modeLabels[kind]}
                    </option>
                  ))}
                </select>
              </label>
              {mode === 'cron' && (
                <>
                  <label className="setup-field">
                    Cron expression
                    <input
                      required
                      value={expression}
                      maxLength={100}
                      onChange={(event) => setExpression(event.target.value)}
                    />
                  </label>
                  <label className="setup-field">
                    Time zone
                    <input
                      required
                      value={timezone}
                      maxLength={100}
                      onChange={(event) => setTimezone(event.target.value)}
                    />
                  </label>
                  <p>The preview lists the next five occurrences in this time zone.</p>
                </>
              )}
              {mode === 'imap' && (
                <>
                  <label className="setup-field">
                    IMAP account
                    <select
                      required
                      value={connectorId}
                      onChange={(event) => setConnectorId(event.target.value)}
                    >
                      <option value="">Select an account</option>
                      {imapAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="setup-field">
                    Mailbox
                    <input
                      required
                      maxLength={200}
                      value={mailbox}
                      onChange={(event) => setMailbox(event.target.value)}
                    />
                  </label>
                  <p>
                    Checks for new email every five minutes. Configure read access in{' '}
                    <Link href="/settings">Settings</Link>.
                  </p>
                </>
              )}
              {mode === 'rss' && (
                <label className="setup-field">
                  RSS feed URL
                  <input
                    type="url"
                    required
                    value={feedUrl}
                    onChange={(event) => setFeedUrl(event.target.value)}
                  />
                </label>
              )}
              {mode === 'webhook' && (
                <label className="setup-field">
                  Webhook credential
                  <select
                    required
                    value={hookSecret}
                    onChange={(event) => setHookSecret(event.target.value)}
                  >
                    <option value="">Choose a vault secret</option>
                    {secrets.data?.map((secret) => (
                      <option key={secret.id} value={secret.reference}>
                        {secret.name}
                      </option>
                    ))}
                  </select>
                  <small>
                    Configure the sender with the signed Sazuz ingress contract after installation.
                    Credentials stay in the vault.
                  </small>
                </label>
              )}
              <button disabled={!session.ready || !projects.data?.length || busy}>
                Preview recipe
              </button>
            </fieldset>
          </form>
        </section>
      )}
      {preview && (
        <section className="durable-card" aria-label="Recipe preview">
          <h2>Review {preview.title}</h2>
          <p>
            {modeLabels[preview.schedule.kind]} ·{' '}
            {preview.policy === 'read_only'
              ? 'Read-only tools'
              : preview.policy === 'draft_send'
                ? 'Read and draft; every send needs approval'
                : 'Every write, send, delete and publish needs approval'}
          </p>
          <p>
            Current limits: {preview.limits.maxSteps} steps, ${preview.limits.maxCostUsd.toFixed(2)}{' '}
            and {preview.limits.maxWallTimeSeconds} seconds per run. Future scheduled runs use the
            limits in Settings.
          </p>
          <ul>
            {preview.approvalPoints.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          {preview.schedule.kind === 'cron' && (
            <>
              <p>
                {preview.schedule.expression} · {preview.schedule.timezone}
              </p>
              <ol>
                {preview.occurrences.map((occurrence) => (
                  <li key={occurrence}>
                    {new Date(occurrence).toLocaleString('en-US', {
                      timeZone:
                        preview.schedule.kind === 'cron' ? preview.schedule.timezone : 'UTC',
                    })}
                  </li>
                ))}
              </ol>
            </>
          )}
          {preview.schedule.kind === 'imap' && (
            <p>
              Account: {preview.schedule.connectorId} · Mailbox: {preview.schedule.mailbox} · Every{' '}
              {preview.schedule.pollIntervalSeconds} seconds
            </p>
          )}
          <details open>
            <summary>Task and sources</summary>
            <pre className="mission-goal">{preview.goal}</pre>
          </details>
          {preview.workflow && (
            <section aria-label="Workflow graph preview">
              <h3>Workflow steps</h3>
              <ol>
                {preview.workflow.nodes.map((node) => (
                  <li key={node.id}>
                    {node.label} · {node.action.kind}
                    {'tool' in node.action ? ` · ${node.action.tool}` : ''}
                  </li>
                ))}
              </ol>
              <details>
                <summary>Inspect graph and connections</summary>
                <pre className="mission-goal">{JSON.stringify(preview.workflow, null, 2)}</pre>
              </details>
            </section>
          )}
          {preview.installedAt ? (
            <p role="status">
              Recipe installed.{' '}
              {preview.missionId && (
                <Link href={`/missions/${preview.missionId}`}>View mission</Link>
              )}
              {preview.triggerId && <Link href="/automations">Manage automation</Link>}
              {preview.workflowId && (
                <>
                  {' '}
                  · <Link href={`/workflows/${preview.workflowId}`}>Edit workflow</Link>
                </>
              )}
            </p>
          ) : (
            <>
              <p>
                Review valid until <LocalTime value={preview.expiresAt} />.
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const result = await api(
                      `recipes/${preview.id}/install`,
                      recipeInstallationSchema,
                      {},
                    );
                    setPreview(result);
                    await installed.refetch();
                    setNotice(result.missionId ? 'Mission queued.' : 'Automation enabled.');
                  })
                }
              >
                {preview.schedule.kind === 'manual'
                  ? 'Install and run'
                  : 'Install and enable automation'}
              </button>
            </>
          )}
        </section>
      )}
      <section className="durable-card" aria-label="Recent recipe installations">
        <h2>Recent previews and installations</h2>
        <ul>
          {installed.data?.map((item) => (
            <li key={item.id}>
              <button className="secondary" disabled={busy} onClick={() => setPreview(item)}>
                {item.title} · {item.installedAt ? 'installed' : 'preview'}
              </button>
              {item.missionId && (
                <>
                  {' '}
                  <Link href={`/missions/${item.missionId}`}>View mission</Link>
                </>
              )}
              {item.triggerId && (
                <>
                  {' '}
                  <Link href="/automations">Manage automation</Link>
                </>
              )}
              {item.workflowId && (
                <>
                  {' '}
                  · <Link href={`/workflows/${item.workflowId}`}>Edit workflow</Link>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    </WorkPageLayout>
  );
}
