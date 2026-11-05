'use client';
import '../lib/validation';
import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { settingsDocumentSchema } from '@sazuz/config/settings';
import { projectSchema } from '@sazuz/core/work';
import {
  controlSchema,
  missionSchema,
  triggerSchema,
  triggerUpdateSchema,
  type Trigger,
  type TriggerInput,
} from '@sazuz/core/missions';
import { api } from '../lib/api';
import { useWorkspaceResource, useWorkspaceSession, workspaceError } from '../lib/use-workspace';
import { WorkPageLayout } from './work-page';
import { agentLabels, LocalTime, RequestNotice } from './durable-shared';
import { TriggerComposer } from './trigger-composer';
import { TelegramPanel } from './telegram-panel';
import { NotificationCenter } from './notification-center';

const triggersSchema = z.array(triggerSchema);
const projectsSchema = z.array(projectSchema);

export function AutomationCenter() {
  const session = useWorkspaceSession();
  const client = useQueryClient();
  const triggers = useWorkspaceResource('triggers', triggersSchema, session.ready);
  const projects = useWorkspaceResource('projects', projectsSchema, session.ready, false);
  const settings = useWorkspaceResource('settings', settingsDocumentSchema, session.ready);
  const control = useWorkspaceResource('control', controlSchema, session.ready);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [lastMission, setLastMission] = useState<string | null>(null);

  async function create(input: TriggerInput) {
    setBusy(true);
    setError('');
    setMessage('');
    setLastMission(null);
    try {
      await api('triggers', triggerSchema, input);
      await triggers.refetch();
      setShowCreate(false);
      setMessage('Automation saved. It follows your project and approval policies.');
      return true;
    } catch (cause) {
      setError(workspaceError(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function change(trigger: Trigger, action: 'toggle' | 'run') {
    setBusy(true);
    setError('');
    setMessage('');
    setLastMission(null);
    try {
      if (action === 'toggle') {
        await api(
          `triggers/${trigger.id}`,
          triggerSchema,
          triggerUpdateSchema.parse({ version: trigger.version, enabled: !trigger.enabled }),
          'PUT',
        );
        setMessage(trigger.enabled ? 'Automation paused.' : 'Automation enabled.');
      } else {
        const mission = await api(`triggers/${trigger.id}/run`, missionSchema, {});
        setLastMission(mission.id);
        setMessage('Mission queued from this automation.');
        await client.invalidateQueries({ queryKey: ['workspace', 'missions'] });
      }
      await triggers.refetch();
    } catch (cause) {
      setError(workspaceError(cause));
      await triggers.refetch();
    } finally {
      setBusy(false);
    }
  }

  return (
    <WorkPageLayout
      current="Automations"
      title="Automations"
      description="Set recurring work, connect Telegram, and choose when to hear from your team."
      actions={
        <button
          disabled={!session.ready || busy}
          aria-expanded={showCreate}
          onClick={() => setShowCreate(!showCreate)}
        >
          {showCreate ? 'Close new automation' : 'New automation'}
        </button>
      }
    >
      <RequestNotice
        error={session.error || triggers.error || projects.error || settings.error}
        message={error}
      />
      {message && (
        <p className="setup-notice" role="status">
          {message} {lastMission && <Link href={`/missions/${lastMission}`}>View mission</Link>}
        </p>
      )}
      <nav className="section-links workspace-section-nav" aria-label="Automation sections">
        <Link href="/recipes">Recipe templates</Link>
        <a href="#triggers">Scheduled and event work</a>
        <a href="#notifications">Notifications and digests</a>
        <a href="#telegram">Telegram</a>
      </nav>
      {control.data?.paused && (
        <p className="setup-notice">
          All agents are paused. Existing automations keep their configuration; use the header
          control to allow work to continue.
        </p>
      )}
      {showCreate && settings.data && projects.data && (
        <TriggerComposer
          projects={projects.data}
          settings={settings.data}
          disabled={busy || !!triggers.error || !!settings.error}
          onCreate={create}
        />
      )}
      <section className="operation-section" id="triggers" aria-label="Scheduled and event work">
        <div className="section-heading">
          <h2>Scheduled and event work</h2>
          <button
            className="secondary"
            disabled={!session.ready || triggers.isFetching}
            onClick={() => {
              void triggers.refetch();
            }}
          >
            Refresh automations
          </button>
        </div>
        {(!session.ready || triggers.isPending) && !session.error && (
          <p role="status">Loading automations…</p>
        )}
        {triggers.data?.length === 0 && (
          <div className="work-empty">
            <h3>Your recurring work starts here</h3>
            <p>
              Create a reviewed schedule, signed webhook, RSS feed, or email trigger. Try a Morning
              Brief to collect updates for your next digest.
            </p>
          </div>
        )}
        <div className="trigger-list">
          {triggers.data?.map((trigger) => (
            <TriggerCard
              key={trigger.id}
              trigger={trigger}
              projectName={
                projects.data?.find((project) => project.id === trigger.projectId)?.name ??
                'Project'
              }
              busy={busy || !!triggers.error}
              paused={control.data?.paused ?? true}
              onAction={change}
            />
          ))}
        </div>
      </section>
      <NotificationCenter ready={session.ready} settings={settings.data} />
      <TelegramPanel ready={session.ready} projects={projects.data ?? []} />
    </WorkPageLayout>
  );
}

function TriggerCard({
  trigger,
  projectName,
  busy,
  paused,
  onAction,
}: {
  trigger: Trigger;
  projectName: string;
  busy: boolean;
  paused: boolean;
  onAction: (trigger: Trigger, action: 'toggle' | 'run') => Promise<void>;
}) {
  const config = trigger.config;
  return (
    <article
      className="durable-card trigger-card"
      aria-label={trigger.name}
      data-enabled={trigger.enabled}
    >
      <header className="durable-heading">
        <div>
          <h3>{trigger.name}</h3>
          <p>
            {projectName} · {agentLabels[trigger.agent]}
          </p>
        </div>
        <span className="work-tag">{trigger.enabled ? 'Enabled' : 'Paused'}</span>
      </header>
      <p className="message-content">{trigger.goal}</p>
      <dl className="trigger-details">
        {config.kind === 'cron' && (
          <>
            <div>
              <dt>Schedule</dt>
              <dd>
                <code>{config.expression}</code> · {config.timezone}
              </dd>
            </div>
            <div>
              <dt>Next run</dt>
              <dd>
                <LocalTime value={trigger.nextRunAt} timezone={config.timezone} />
              </dd>
            </div>
          </>
        )}
        {config.kind === 'rss' && (
          <>
            <div>
              <dt>RSS feed</dt>
              <dd>{config.url}</dd>
            </div>
            <div>
              <dt>Polling</dt>
              <dd>Every {config.pollIntervalSeconds} seconds</dd>
            </div>
          </>
        )}
        {config.kind === 'imap' && (
          <>
            <div>
              <dt>Mailbox</dt>
              <dd>
                {config.mailbox} · {config.connectorId}
              </dd>
            </div>
            <div>
              <dt>Polling</dt>
              <dd>Every {config.pollIntervalSeconds} seconds</dd>
            </div>
          </>
        )}
        {config.kind === 'webhook' && (
          <div>
            <dt>Signed webhook</dt>
            <dd>
              <code>{trigger.webhookPath ?? 'Path unavailable'}</code>
              <small>The sender must sign each payload with the selected vault credential.</small>
            </dd>
          </div>
        )}
        <div>
          <dt>Last run</dt>
          <dd>
            <LocalTime value={trigger.lastRunAt} />
          </dd>
        </div>
      </dl>
      {trigger.lastError && <p className="setup-error">{trigger.lastError}</p>}
      <div className="durable-actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            void onAction(trigger, 'toggle');
          }}
        >
          {trigger.enabled ? 'Pause automation' : 'Enable automation'}
        </button>
        <button
          disabled={busy || paused}
          onClick={() => {
            void onAction(trigger, 'run');
          }}
        >
          Run once
        </button>
      </div>
    </article>
  );
}
