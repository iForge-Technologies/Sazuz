import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { z } from 'zod';
import type { projectSchema } from '@sazuz/core/work';
import {
  telegramPairInputSchema,
  telegramPairSchema,
  telegramStatusSchema,
} from '@sazuz/core/missions';
import { api, okSchema } from '../lib/api';
import { useWorkspaceResource, workspaceError } from '../lib/use-workspace';
import { LocalTime, RequestNotice } from './durable-shared';

export function TelegramPanel({
  ready,
  projects,
}: {
  ready: boolean;
  projects: z.infer<typeof projectSchema>[];
}) {
  const status = useWorkspaceResource('channels/telegram', telegramStatusSchema, ready);
  const [projectId, setProjectId] = useState('');
  const [pair, setPair] = useState<z.infer<typeof telegramPairSchema> | null>(null);
  const [unpairId, setUnpairId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const selectedProject = projectId || projects[0]?.id || '';
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  async function pairAccount() {
    setBusy(true);
    setError('');
    setMessage('');
    setPair(null);
    try {
      setPair(
        await api(
          'channels/telegram/pair',
          telegramPairSchema,
          telegramPairInputSchema.parse({ projectId: selectedProject }),
        ),
      );
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function removeBinding(id: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api(`channels/telegram/bindings/${id}`, okSchema, {}, 'DELETE');
      setUnpairId(null);
      await status.refetch();
      setMessage('Telegram account unpaired. It can no longer send commands to this workspace.');
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  const expired = !!pair && new Date(pair.expiresAt).getTime() <= now;
  return (
    <section
      id="telegram"
      className="durable-card automation-section"
      aria-label="Telegram pairing"
    >
      <header className="durable-heading">
        <div>
          <h2>Telegram</h2>
          <p>Send missions and review approval requests from your paired account.</p>
        </div>
        <Link href="/settings?section=channels">Channel settings</Link>
      </header>
      <RequestNotice error={status.error} message={error} />
      {message && (
        <p className="setup-notice" role="status">
          {message}
        </p>
      )}
      {ready && status.isPending && <p role="status">Loading Telegram status…</p>}
      {status.data && (
        <>
          {!status.data.configured ? (
            <p className="setup-notice">
              Save your Telegram bot token in{' '}
              <Link href="/settings?section=channels">Channel settings</Link> to start pairing.
            </p>
          ) : (
            <>
              <p className="work-muted">
                Send a pairing command to your own bot. Keep it private until pairing completes; the
                code expires and can be used once.
              </p>
              <form
                className="telegram-pair-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void pairAccount();
                }}
              >
                <fieldset disabled={busy || !projects.length || !!status.error}>
                  <label className="setup-field">
                    Telegram project
                    <select
                      value={selectedProject}
                      onChange={(event) => {
                        setProjectId(event.target.value);
                        setPair(null);
                      }}
                    >
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                    <small>New missions from this account go to this project.</small>
                  </label>
                  <button>
                    {busy
                      ? 'Updating…'
                      : pair
                        ? 'Generate new pairing code'
                        : 'Generate pairing code'}
                  </button>
                </fieldset>
              </form>
              {!projects.length && (
                <p>
                  Create a project in <Link href="/chat">Chat</Link> before pairing.
                </p>
              )}
              {pair && (
                <div className="pair-command" role="status">
                  {expired ? (
                    <p>This pairing code expired. Generate a new code to continue.</p>
                  ) : (
                    <>
                      <p>Send this command in a private message to your bot:</p>
                      <code>{pair.command}</code>
                      <p>
                        Expires <LocalTime value={pair.expiresAt} />.
                      </p>
                    </>
                  )}
                </div>
              )}
              <div className="durable-actions">
                <button
                  className="secondary"
                  disabled={status.isFetching || busy}
                  onClick={() => {
                    void status.refetch();
                  }}
                >
                  Refresh pairing status
                </button>
                <span className="work-muted">
                  Last checked <LocalTime value={status.data.lastPollAt} />
                </span>
              </div>
            </>
          )}
          {status.data.lastError && <p className="setup-error">{status.data.lastError}</p>}
          <h3>Paired accounts ({status.data.bindings.length})</h3>
          {!status.data.bindings.length && (
            <p className="work-muted">
              No Telegram account is paired. Messages from unknown senders are ignored.
            </p>
          )}
          <ul className="telegram-bindings">
            {status.data.bindings.map((binding) => (
              <li key={binding.id}>
                <div>
                  <strong>
                    {projects.find((project) => project.id === binding.projectId)?.name ??
                      'Project'}
                  </strong>
                  <p>
                    Telegram user {binding.senderId} · Chat {binding.chatId}
                  </p>
                  <span className="work-muted">
                    Paired <LocalTime value={binding.createdAt} />
                  </span>
                </div>
                {unpairId === binding.id ? (
                  <div className="unpair-confirmation">
                    <p>Remove this account’s access to commands and approvals?</p>
                    <div className="durable-actions">
                      <button
                        disabled={busy}
                        onClick={() => {
                          void removeBinding(binding.id);
                        }}
                      >
                        Confirm unpair
                      </button>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => setUnpairId(null)}
                      >
                        Keep paired
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="secondary"
                    disabled={busy || !!status.error}
                    onClick={() => setUnpairId(binding.id)}
                  >
                    Unpair account
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="work-muted">
            Paired accounts can use <code>/status</code>, <code>/stop</code> and{' '}
            <code>/digest</code>, or send a mission in a message. Approval buttons apply to the
            exact request shown.
          </p>
        </>
      )}
    </section>
  );
}
