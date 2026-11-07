'use client';
import '../lib/validation';
import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { z } from 'zod';
import { channelConnectionSchema, type ChannelConnection } from '@sazuz/config/integrations';
import { projectSchema } from '@sazuz/core/work';
import { settingsDocumentSchema } from '@sazuz/config/settings';
import { api, okSchema, secretListSchema, type SecretItem } from '../lib/api';
import { useWorkspaceResource, useWorkspaceSession, workspaceError } from '../lib/use-workspace';
import { WorkPageLayout } from './work-page';
import { RequestNotice } from './durable-shared';
import { CredentialSelect } from './mcp-connections';

const documentSchema = z.object({
  version: z.number(),
  connections: z.array(channelConnectionSchema),
});
const qrSchema = z.object({
  state: z.enum(['connecting', 'qr', 'connected', 'disconnected', 'error']),
  qr: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
const names = {
  discord: 'Discord',
  slack: 'Slack',
  'whatsapp-cloud': 'WhatsApp Cloud API',
  'whatsapp-qr': 'WhatsApp QR session',
} as const;
export function ChannelCenter() {
  const session = useWorkspaceSession();
  const document = useWorkspaceResource(
    'channels/connections',
    documentSchema,
    session.ready,
    false,
  );
  const secrets = useWorkspaceResource('vault/secrets', secretListSchema, session.ready, false);
  const projects = useWorkspaceResource('projects', z.array(projectSchema), session.ready, false);
  const settings = useWorkspaceResource('settings', settingsDocumentSchema, session.ready, false);
  return (
    <WorkPageLayout
      current="Channels"
      title="Channels"
      description="Send tasks to your agents from the places you already use."
    >
      <RequestNotice error={document.error || secrets.error || projects.error || session.error} />
      <p>
        Telegram pairing and notifications remain in <Link href="/automations">Automations</Link>.
        Store channel credentials in the <Link href="/settings">vault</Link>. Only explicitly
        allowed senders can create tasks.
      </p>
      {document.data && (
        <ChannelEditor
          key={document.data.version}
          document={document.data}
          secrets={secrets.data ?? []}
          projects={projects.data ?? []}
          baseUrl={settings.data?.general.value.baseUrl ?? ''}
          refresh={() => document.refetch()}
        />
      )}
    </WorkPageLayout>
  );
}
function ChannelEditor({
  document,
  secrets,
  projects,
  baseUrl,
  refresh,
}: {
  document: z.infer<typeof documentSchema>;
  secrets: SecretItem[];
  projects: z.infer<typeof projectSchema>[];
  baseUrl: string;
  refresh: () => Promise<unknown>;
}) {
  const [connections, setConnections] = useState(document.connections);
  const [selected, setSelected] = useState(document.connections[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [qr, setQr] = useState<z.infer<typeof qrSchema> | null>(null);
  const connection = connections.find((item) => item.id === selected);
  const dirty = JSON.stringify(connections) !== JSON.stringify(document.connections);
  const update = (fields: Partial<ChannelConnection>) =>
    setConnections((items) =>
      items.map((item) => (item.id === selected ? { ...item, ...fields } : item)),
    );
  useEffect(() => {
    if (
      !connection ||
      connection.kind !== 'whatsapp-qr' ||
      !document.connections.some((item) => item.id === connection.id)
    )
      return;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const status = await api(`channels/${connection.id}/status`, qrSchema, undefined, 'GET', {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setQr(status);
      } catch (cause) {
        if (!controller.signal.aborted) setError(workspaceError(cause));
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 2500);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [connection?.id, connection?.kind, document.connections]);
  async function action(kind: 'save' | 'connect' | 'disconnect') {
    setBusy(true);
    setError('');
    try {
      if (kind === 'save') {
        await api(
          'channels/connections',
          documentSchema,
          {
            version: document.version,
            connections: connections.map((item) => ({
              ...item,
              allowedSenders: item.allowedSenders.map((value) => value.trim()).filter(Boolean),
              allowedConversations: item.allowedConversations
                .map((value) => value.trim())
                .filter(Boolean),
            })),
          },
          'PUT',
        );
        await refresh();
      } else if (connection) {
        await api(`channels/${connection.id}/${kind}`, okSchema, {});
        setQr(null);
      }
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="integration-panel">
      <div className="integration-toolbar">
        {(Object.keys(names) as ChannelConnection['kind'][]).map((kind) => (
          <button
            key={kind}
            disabled={busy || !projects.length || connections.length >= 30}
            onClick={() => {
              const id = `channel_${crypto.randomUUID().slice(0, 8)}`;
              setConnections([
                ...connections,
                channelConnectionSchema.parse({
                  id,
                  name: names[kind],
                  kind,
                  projectId: projects[0]!.id,
                }),
              ]);
              setSelected(id);
              setQr(null);
            }}
          >
            + {names[kind]}
          </button>
        ))}
        <button disabled={busy || !dirty} onClick={() => void action('save')}>
          Save channels
        </button>
      </div>
      <RequestNotice message={error} />
      <div className="integration-tabs">
        {connections.map((item) => (
          <button
            key={item.id}
            aria-pressed={selected === item.id}
            onClick={() => {
              setSelected(item.id);
              setQr(null);
            }}
          >
            {item.name}
            <small>
              {item.enabled ? 'Enabled' : 'Disabled'} · {names[item.kind]}
            </small>
          </button>
        ))}
      </div>
      {connection ? (
        <div className="integration-grid">
          <div>
            <label>
              Name
              <input
                value={connection.name}
                maxLength={120}
                onChange={(event) => update({ name: event.target.value })}
              />
            </label>
            <label>
              Project
              <select
                value={connection.projectId}
                onChange={(event) => update({ projectId: event.target.value })}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Allowed sender IDs (one per line)
              <textarea
                rows={4}
                value={connection.allowedSenders.join('\n')}
                onChange={(event) => update({ allowedSenders: event.target.value.split('\n') })}
              />
            </label>
            <label>
              Allowed conversation IDs (optional, one per line)
              <textarea
                rows={3}
                value={connection.allowedConversations.join('\n')}
                onChange={(event) =>
                  update({
                    allowedConversations: event.target.value ? event.target.value.split('\n') : [],
                  })
                }
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={connection.enabled}
                onChange={(event) => update({ enabled: event.target.checked })}
              />{' '}
              Enable channel
            </label>
            <button
              disabled={busy}
              onClick={() => {
                setConnections(connections.filter((item) => item.id !== connection.id));
                setSelected('');
              }}
            >
              Remove configuration
            </button>
          </div>
          <div>
            {connection.kind !== 'whatsapp-qr' && (
              <>
                <CredentialSelect
                  label={connection.kind === 'whatsapp-cloud' ? 'Access token' : 'Bot token'}
                  value={connection.secretRef}
                  secrets={secrets}
                  change={(secretRef) => update({ secretRef })}
                />
                <p>
                  Webhook URL:{' '}
                  <code className="integration-url">
                    {baseUrl.replace(/\/$/, '')}/channels/hooks/{connection.id}
                  </code>
                </p>
                <p>
                  Your webhook URL must be reachable through HTTPS. Configure your public instance
                  URL in Settings.
                </p>
              </>
            )}
            {connection.kind === 'discord' && (
              <>
                <label>
                  Application ID
                  <input
                    value={connection.applicationId}
                    onChange={(event) => update({ applicationId: event.target.value })}
                  />
                </label>
                <label>
                  Application public key
                  <input
                    value={connection.publicKey}
                    onChange={(event) => update({ publicKey: event.target.value })}
                  />
                </label>
                <p>
                  Use this URL as your Discord interaction endpoint. Register a <code>/sazuz</code>{' '}
                  command with a required string option named <code>task</code>. Invite the bot with
                  permission to view channels and send messages.
                </p>
              </>
            )}
            {connection.kind === 'slack' && (
              <>
                <label>
                  App ID
                  <input
                    value={connection.applicationId}
                    onChange={(event) => update({ applicationId: event.target.value })}
                  />
                </label>
                <CredentialSelect
                  label="Signing secret"
                  value={connection.signingSecretRef}
                  secrets={secrets}
                  change={(signingSecretRef) => update({ signingSecretRef })}
                />
                <p>
                  Set this URL in Event Subscriptions. Subscribe to app mentions and direct
                  messages; grant <code>app_mentions:read</code>, <code>im:history</code> and{' '}
                  <code>chat:write</code>. Invite the app to the intended channels.
                </p>
              </>
            )}
            {connection.kind === 'whatsapp-cloud' && (
              <>
                <label>
                  Phone number ID
                  <input
                    value={connection.phoneNumberId}
                    onChange={(event) => update({ phoneNumberId: event.target.value })}
                  />
                </label>
                <label>
                  Graph API version
                  <input
                    value={connection.apiVersion}
                    onChange={(event) => update({ apiVersion: event.target.value })}
                  />
                </label>
                <CredentialSelect
                  label="Meta app secret"
                  value={connection.signingSecretRef}
                  secrets={secrets}
                  change={(signingSecretRef) => update({ signingSecretRef })}
                />
                <CredentialSelect
                  label="Webhook verification token"
                  value={connection.verifyTokenRef}
                  secrets={secrets}
                  change={(verifyTokenRef) => update({ verifyTokenRef })}
                />
                <p>
                  Use the official WhatsApp Business Platform. Subscribe to message webhooks.
                  Allowed senders use international phone numbers with digits only. Text replies
                  follow the platform’s messaging window.
                </p>
              </>
            )}
            {connection.kind === 'whatsapp-qr' && (
              <>
                <h2>Link your WhatsApp device</h2>
                <p>
                  This optional mode uses an unofficial linked-device client for a normal WhatsApp
                  account. It is separate from the official Cloud API and can be affected by
                  WhatsApp changes or account restrictions.
                </p>
                <p>
                  Save and enable this connection, then link from WhatsApp → Linked devices. Allow
                  sender IDs such as <code>15551234567@s.whatsapp.net</code>. Device credentials
                  stay in your vault.
                </p>
                <div className="integration-toolbar">
                  <button
                    disabled={busy || dirty || !connection.enabled}
                    onClick={() => void action('connect')}
                  >
                    Connect / show QR
                  </button>
                  <button disabled={busy || dirty} onClick={() => void action('disconnect')}>
                    Unlink device
                  </button>
                </div>
                <p role="status">{qr ? `Session: ${qr.state}` : 'Not connected'}</p>
                {qr?.qr && (
                  <Image
                    unoptimized
                    src={qr.qr}
                    width={280}
                    height={280}
                    alt="Scan this temporary QR code from WhatsApp Linked devices"
                  />
                )}
                <p>QR codes expire automatically. Linking does not import your message history.</p>
              </>
            )}
          </div>
        </div>
      ) : (
        <p>Add or select a channel to configure it.</p>
      )}
    </section>
  );
}
