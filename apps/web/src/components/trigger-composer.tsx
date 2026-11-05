import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { z } from 'zod';
import type { SettingsDocument } from '@sazuz/config/settings';
import type { projectSchema } from '@sazuz/core/work';
import {
  agentRoleSchema,
  schedulePreviewInputSchema,
  schedulePreviewSchema,
  triggerInputSchema,
  type AgentRole,
  type Trigger,
  type TriggerInput,
} from '@sazuz/core/missions';
import { api, secretListSchema } from '../lib/api';
import { useWorkspaceResource, workspaceError } from '../lib/use-workspace';
import { agentLabels, LocalTime, RequestNotice } from './durable-shared';

type SchedulePreview = z.infer<typeof schedulePreviewSchema>;
type Project = z.infer<typeof projectSchema>;

export function TriggerComposer({
  projects,
  settings,
  disabled,
  onCreate,
}: {
  projects: Project[];
  settings: SettingsDocument;
  disabled: boolean;
  onCreate: (input: TriggerInput) => Promise<boolean>;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [agent, setAgent] = useState<AgentRole>('cos');
  const [kind, setKind] = useState<Trigger['config']['kind']>('cron');
  const [scheduleMode, setScheduleMode] = useState<'text' | 'expression'>('text');
  const [schedule, setSchedule] = useState('Every weekday at 9am');
  const [timezone, setTimezone] = useState(settings.general.value.timezone);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [url, setUrl] = useState('');
  const [interval, setIntervalValue] = useState('300');
  const [connectorId, setConnectorId] = useState('');
  const [mailbox, setMailbox] = useState('INBOX');
  const [secretRef, setSecretRef] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const secrets = useWorkspaceResource(
    'vault/secrets',
    secretListSchema,
    kind === 'webhook',
    false,
  );
  const mailAccounts = settings.connectors.value.accounts.filter(
    (account) => account.provider === 'imap-smtp' && account.scopes.includes('email:read'),
  );
  const selectedConnector = connectorId || mailAccounts[0]?.id || '';
  const expired = !!preview && new Date(preview.expiresAt).getTime() <= now;
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  function clearReview() {
    setPreview(null);
    setReviewed(false);
    setError('');
  }
  async function reviewSchedule() {
    setBusy(true);
    setError('');
    clearReview();
    try {
      const parsed = schedulePreviewInputSchema.safeParse({ [scheduleMode]: schedule, timezone });
      if (!parsed.success) {
        setError('Enter a schedule and a valid timezone, such as Asia/Kolkata.');
        return;
      }
      const result = await api('triggers/preview', schedulePreviewSchema, parsed.data);
      setPreview(result);
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setError('');
    if (
      kind === 'cron' &&
      (!preview || !reviewed || new Date(preview.expiresAt).getTime() <= Date.now())
    ) {
      setError('Preview this schedule and confirm the upcoming times before saving.');
      return;
    }
    const config =
      kind === 'cron'
        ? { kind, expression: preview?.expression, timezone: preview?.timezone }
        : kind === 'rss'
          ? { kind, url, pollIntervalSeconds: Number(interval) }
          : kind === 'imap'
            ? {
                kind,
                connectorId: selectedConnector,
                mailbox,
                pollIntervalSeconds: Number(interval),
              }
            : { kind, secretRef };
    const input = triggerInputSchema.safeParse({
      projectId,
      name,
      goal,
      agent,
      config,
      enabled,
      ...(kind === 'cron' ? { reviewToken: preview?.reviewToken } : {}),
    });
    if (!input.success) {
      setError(
        `Check these fields: ${[...new Set(input.error.issues.map((issue) => issue.path.join('.')))].join(', ')}.`,
      );
      return;
    }
    await onCreate(input.data);
  }

  return (
    <section className="durable-card trigger-composer" aria-label="New automation">
      <h2>Set up recurring work</h2>
      {!projects.length ? (
        <p>
          Create a project in <Link href="/chat">Chat</Link> before adding an automation.
        </p>
      ) : (
        <form
          className="work-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={disabled || busy}>
            <div className="form-columns">
              <label className="setup-field">
                Automation name
                <input
                  required
                  maxLength={160}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Morning Brief"
                />
              </label>
              <label className="setup-field">
                Project
                <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                      {project.privacy === 'private' ? ' · private' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="setup-field">
              Mission goal
              <textarea
                required
                maxLength={16000}
                rows={3}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder="Collect today’s priorities and prepare a short brief for my digest."
              />
            </label>
            <div className="form-columns">
              <label className="setup-field">
                Assign to
                <select
                  value={agent}
                  onChange={(event) => setAgent(agentRoleSchema.parse(event.target.value))}
                >
                  {agentRoleSchema.options.map((role) => (
                    <option key={role} value={role}>
                      {agentLabels[role]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="setup-field">
                Trigger type
                <select
                  value={kind}
                  onChange={(event) => {
                    const candidate = event.target.value;
                    if (
                      candidate === 'cron' ||
                      candidate === 'webhook' ||
                      candidate === 'rss' ||
                      candidate === 'imap'
                    )
                      setKind(candidate);
                    clearReview();
                  }}
                >
                  <option value="cron">Schedule</option>
                  <option value="webhook">Signed webhook</option>
                  <option value="rss">RSS feed</option>
                  <option value="imap">Email arrival (IMAP)</option>
                </select>
              </label>
            </div>
            {kind === 'cron' && (
              <section className="schedule-composer" aria-label="Schedule configuration">
                <label className="setup-field">
                  Schedule format
                  <select
                    value={scheduleMode}
                    onChange={(event) => {
                      setScheduleMode(event.target.value === 'expression' ? 'expression' : 'text');
                      setSchedule('');
                      clearReview();
                    }}
                  >
                    <option value="text">Describe in words</option>
                    <option value="expression">Cron expression</option>
                  </select>
                </label>
                <div className="form-columns">
                  <label className="setup-field">
                    {scheduleMode === 'text' ? 'Schedule description' : 'Cron expression'}
                    <input
                      required
                      maxLength={scheduleMode === 'text' ? 1000 : 100}
                      value={schedule}
                      onChange={(event) => {
                        setSchedule(event.target.value);
                        clearReview();
                      }}
                      placeholder={scheduleMode === 'text' ? 'Every weekday at 9am' : '0 9 * * 1-5'}
                    />
                  </label>
                  <label className="setup-field">
                    Schedule timezone
                    <input
                      required
                      maxLength={100}
                      value={timezone}
                      onChange={(event) => {
                        setTimezone(event.target.value);
                        clearReview();
                      }}
                      placeholder="Asia/Kolkata"
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void reviewSchedule();
                  }}
                >
                  {busy ? 'Preparing preview…' : 'Preview schedule'}
                </button>
                {preview && (
                  <section className="schedule-review" aria-label="Schedule review">
                    <h3>Review when this will run</h3>
                    <p>{preview.summary}</p>
                    <p>
                      <code>{preview.expression}</code> · {preview.timezone}
                    </p>
                    <ol>
                      {preview.occurrences.map((occurrence) => (
                        <li key={occurrence}>
                          <LocalTime value={occurrence} timezone={preview.timezone} />
                        </li>
                      ))}
                    </ol>
                    <p className="work-muted">
                      Preview expires <LocalTime value={preview.expiresAt} />.
                    </p>
                    {expired ? (
                      <p className="setup-error" role="status">
                        This preview expired. Preview the schedule again before saving.
                      </p>
                    ) : (
                      <label className="setup-check">
                        <input
                          type="checkbox"
                          checked={reviewed}
                          onChange={(event) => setReviewed(event.target.checked)}
                        />
                        I reviewed these times and the timezone
                      </label>
                    )}
                  </section>
                )}
              </section>
            )}
            {kind === 'rss' && (
              <label className="setup-field">
                RSS feed URL
                <input
                  type="url"
                  required
                  maxLength={2048}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.com/feed.xml"
                />
                <small>
                  New feed items start missions once. Feed content is treated as external content.
                </small>
              </label>
            )}
            {kind === 'imap' && (
              <>
                <label className="setup-field">
                  Email account
                  <select
                    required
                    value={selectedConnector}
                    onChange={(event) => setConnectorId(event.target.value)}
                  >
                    <option value="">Choose a configured IMAP account</option>
                    {mailAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                  <small>
                    Configure IMAP and the email:read scope in{' '}
                    <Link href="/settings?section=connectors">Connector settings</Link>.
                  </small>
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
              </>
            )}
            {(kind === 'rss' || kind === 'imap') && (
              <label className="setup-field">
                Poll interval (seconds)
                <input
                  type="number"
                  required
                  min="60"
                  max="86400"
                  step="1"
                  value={interval}
                  onChange={(event) => setIntervalValue(event.target.value)}
                />
              </label>
            )}
            {kind === 'webhook' && (
              <>
                <label className="setup-field">
                  Webhook signing credential
                  <select
                    required
                    value={secretRef}
                    onChange={(event) => setSecretRef(event.target.value)}
                  >
                    <option value="">Choose a vault credential</option>
                    {secrets.data?.map((secret) => (
                      <option key={secret.id} value={secret.reference}>
                        {secret.name} {secret.maskedValue}
                      </option>
                    ))}
                  </select>
                  <small>
                    Create a dedicated signing secret in{' '}
                    <Link href="/settings?section=connectors#vault">Settings</Link> and configure
                    the same value on your webhook sender. The endpoint appears after saving.
                  </small>
                </label>
                <RequestNotice error={secrets.error} />
              </>
            )}
            <label className="setup-check">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              Enable this automation when saved
            </label>
            <p className="work-muted">Each run uses your current budgets and approval policy.</p>
            <button disabled={kind === 'cron' && (!preview || !reviewed || expired)}>
              {disabled ? 'Saving…' : 'Save automation'}
            </button>
          </fieldset>
        </form>
      )}
      {error && (
        <p className="setup-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
