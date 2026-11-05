import { useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import type { SettingsDocument } from '@sazuz/config/settings';
import { digestSchema, notificationSchema } from '@sazuz/core/missions';
import { useWorkspaceResource } from '../lib/use-workspace';
import { LocalTime, RequestNotice } from './durable-shared';
import { notificationFeedbackSchema } from '@sazuz/core/calm';
import { api } from '../lib/api';
import { workspaceError } from '../lib/use-workspace';

const notificationsSchema = z.array(notificationSchema);
const digestsSchema = z.array(digestSchema);
const deliveryLabels: Record<z.infer<typeof notificationSchema>['status'], string> = {
  pending: 'Pending delivery',
  deferred: 'Deferred',
  digested: 'Added to digest',
  delivered: 'Delivered',
  logged: 'Saved to activity',
  uncertain: 'Delivery unconfirmed',
};
const digestLabels: Record<z.infer<typeof digestSchema>['deliveryStatus'], string> = {
  web: 'Available here',
  pending: 'Delivery pending',
  delivered: 'Delivered',
  uncertain: 'Delivery unconfirmed',
};

export function NotificationCenter({
  ready,
  settings,
}: {
  ready: boolean;
  settings: SettingsDocument | undefined;
}) {
  const [search, setSearch] = useState(''),
    [query, setQuery] = useState('');
  const notifications = useWorkspaceResource(
    'notifications' + (query ? '?q=' + encodeURIComponent(query) : ''),
    notificationsSchema,
    ready,
  );
  const digests = useWorkspaceResource('digests', digestsSchema, ready);
  const [view, setView] = useState<'notifications' | 'digests'>('digests');
  return (
    <section
      id="notifications"
      className="durable-card automation-section"
      aria-label="Notifications and digests"
    >
      <header className="durable-heading">
        <div>
          <h2>Notifications and digests</h2>
          <p>Catch up at your pace and see which updates still need delivery.</p>
        </div>
        <Link href="/settings?section=profile">Quiet hours and digest times</Link>
      </header>
      {settings && (
        <div className="calm-summary">
          <p>
            Quiet hours{' '}
            <strong>
              {settings.profile.value.quietStart}–{settings.profile.value.quietEnd}
            </strong>{' '}
            · {settings.general.value.timezone}
          </p>
          <p>
            Digests{' '}
            <strong>{settings.profile.value.digestTimes.join(', ') || 'Not scheduled'}</strong> ·{' '}
            {settings.channels.value.digest === 'web'
              ? 'In this workspace'
              : `Via ${settings.channels.value.digest}`}
          </p>
          <p>
            Noise budget <strong>{settings.profile.value.noiseBudget}</strong> interruptions per day
            · Urgent updates via {settings.channels.value.urgent}
          </p>
        </div>
      )}
      <RequestNotice error={notifications.error || digests.error} />
      <form
        className="durable-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search);
          setView('notifications');
        }}
      >
        <label className="setup-field">
          Search notifications
          <input
            type="search"
            maxLength={200}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button type="submit">Search</button>
      </form>
      <div className="durable-toolbar">
        <label className="setup-field">
          Activity view
          <select
            value={view}
            onChange={(event) =>
              setView(event.target.value === 'notifications' ? 'notifications' : 'digests')
            }
          >
            <option value="digests">Digests</option>
            <option value="notifications">Notifications</option>
          </select>
        </label>
        <button
          className="secondary"
          disabled={!ready || notifications.isFetching || digests.isFetching}
          onClick={() => {
            void notifications.refetch();
            void digests.refetch();
          }}
        >
          Refresh activity
        </button>
      </div>
      {ready && (notifications.isPending || digests.isPending) && (
        <p role="status">Loading activity…</p>
      )}
      {view === 'digests' ? (
        <div className="activity-list">
          {digests.data?.length === 0 && (
            <p className="work-muted">
              No digests yet. Completed scheduled work and quiet updates will appear in your next
              digest.
            </p>
          )}
          {digests.data?.map((digest) => (
            <article key={digest.id} aria-label={digest.title}>
              <header className="durable-heading">
                <h3>{digest.title}</h3>
                <span className="work-tag">{digestLabels[digest.deliveryStatus]}</span>
              </header>
              <p className="work-muted">
                {digest.itemCount} {digest.itemCount === 1 ? 'update' : 'updates'} ·{' '}
                <LocalTime value={digest.createdAt} />
              </p>
              <p className="message-content">{digest.body}</p>
              {digest.deliveryStatus === 'uncertain' && (
                <p className="uncertain-notice">
                  Check Telegram before requesting another delivery. The previous delivery may have
                  arrived.
                </p>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="activity-list">
          {notifications.data?.length === 0 && (
            <p className="work-muted">
              No notifications yet. Your team’s updates will appear here.
            </p>
          )}
          {notifications.data?.map((notification) => (
            <article key={notification.id} aria-label={notification.title}>
              <header className="durable-heading">
                <h3>{notification.title}</h3>
                <span className="work-tag">{deliveryLabels[notification.status]}</span>
              </header>
              <p className="work-muted">
                {notification.level.charAt(0).toUpperCase() + notification.level.slice(1)} ·{' '}
                <LocalTime value={notification.createdAt} />
              </p>
              <p className="message-content">{notification.body}</p>
              {notification.priorityEvidence && (
                <details>
                  <summary>
                    Why this priority? Score {notification.priorityEvidence.score}/100
                  </summary>
                  <p>{notification.priorityEvidence.reasons.join(' · ')}</p>
                  <p>
                    {notification.priorityEvidence.model === 'classified'
                      ? 'Rules and Fast classification'
                      : 'Rules'}{' '}
                    · Preference adjustment {notification.priorityEvidence.bias}
                  </p>
                </details>
              )}
              <NotificationFeedback
                notification={notification}
                refresh={async () => {
                  await notifications.refetch();
                }}
              />
              {notification.dueAt && (
                <p className="work-muted">
                  Delivery due <LocalTime value={notification.dueAt} />
                </p>
              )}
              {notification.status === 'uncertain' && (
                <p className="uncertain-notice">
                  Delivery could not be confirmed. Check the destination before repeating this
                  action.
                </p>
              )}
              {notification.missionId && (
                <Link className="work-action-link" href={`/missions/${notification.missionId}`}>
                  View mission
                </Link>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function NotificationFeedback({
  notification,
  refresh,
}: {
  notification: z.infer<typeof notificationSchema>;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [receipt, setReceipt] = useState<{
    kind: 'not_important' | 'sooner';
    requestId: string;
  } | null>(null);
  async function vote(kind: 'not_important' | 'sooner') {
    const input = receipt?.kind === kind ? receipt : { kind, requestId: crypto.randomUUID() };
    setReceipt(input);
    setBusy(true);
    setError('');
    try {
      await api(`notifications/${notification.id}/feedback`, notificationFeedbackSchema, input);
      await refresh();
      setReceipt(null);
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="durable-actions">
      <button
        disabled={busy || notification.feedback === 'not_important'}
        onClick={() => void vote('not_important')}
      >
        Not important
      </button>
      <button
        disabled={busy || notification.feedback === 'sooner'}
        onClick={() => void vote('sooner')}
      >
        Should have told me sooner
      </button>
      {notification.feedback && (
        <span role="status">Preference saved for this source in this project.</span>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
