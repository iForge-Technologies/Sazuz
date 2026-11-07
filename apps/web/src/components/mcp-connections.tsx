'use client';
import '../lib/validation';
import { useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { mcpConnectionSchema, mcpToolSchema, type McpConnection } from '@sazuz/config/integrations';
import { agentRoleSchema } from '@sazuz/core/agents';
import { api, secretListSchema, type SecretItem } from '../lib/api';
import { useWorkspaceResource, useWorkspaceSession, workspaceError } from '../lib/use-workspace';
import { WorkPageLayout } from './work-page';
import { RequestNotice } from './durable-shared';

const documentSchema = z.object({ version: z.number(), connections: z.array(mcpConnectionSchema) });
export function CredentialSelect({
  label,
  value,
  secrets,
  change,
}: {
  label: string;
  value: string | null;
  secrets: SecretItem[];
  change: (value: string | null) => void;
}) {
  return (
    <label>
      {label}
      <select value={value ?? ''} onChange={(event) => change(event.target.value || null)}>
        <option value="">None</option>
        {secrets.map((secret) => (
          <option key={secret.id} value={secret.reference}>
            {secret.name} · {secret.maskedValue}
          </option>
        ))}
      </select>
    </label>
  );
}
export function McpConnections() {
  const session = useWorkspaceSession();
  const document = useWorkspaceResource('mcp/connections', documentSchema, session.ready, false);
  const secrets = useWorkspaceResource('vault/secrets', secretListSchema, session.ready, false);
  return (
    <WorkPageLayout
      current="MCP"
      title="MCP connections"
      description="Connect remote tools to your agents and S2A workflows."
    >
      <RequestNotice error={document.error || secrets.error || session.error} />
      <p>
        Use a Streamable HTTP HTTPS endpoint. Store its bearer token in the{' '}
        <Link href="/settings">vault</Link>, then discover and review the tools. For project
        installations and sandboxed stdio servers, open <Link href="/connectors">Connectors</Link>.
      </p>
      <p>
        Grant selected agents the <code>mcp_connection.*</code> tool permission in{' '}
        <Link href="/agents">Agents</Link>. Their current permissions and tool effects apply to
        every call.
      </p>
      {document.data && (
        <McpEditor
          key={document.data.version}
          document={document.data}
          secrets={secrets.data ?? []}
          refresh={() => document.refetch()}
        />
      )}
    </WorkPageLayout>
  );
}
function McpEditor({
  document,
  secrets,
  refresh,
}: {
  document: z.infer<typeof documentSchema>;
  secrets: SecretItem[];
  refresh: () => Promise<unknown>;
}) {
  const [connections, setConnections] = useState(document.connections);
  const [selected, setSelected] = useState(document.connections[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const connection = connections.find((item) => item.id === selected);
  const update = (fields: Partial<McpConnection>) =>
    setConnections((items) =>
      items.map((item) => (item.id === selected ? { ...item, ...fields } : item)),
    );
  async function save() {
    setBusy(true);
    setError('');
    try {
      await api(
        'mcp/connections',
        documentSchema,
        { version: document.version, connections },
        'PUT',
      );
      await refresh();
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function discover() {
    if (!connection) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api(
        'mcp/discover',
        z.object({ tools: z.array(mcpToolSchema), sessionCleanup: z.string().optional() }),
        connection,
      );
      update({ tools: result.tools });
      setMessage(
        `${result.tools.length} tools discovered. Review effects and access, then save. Previous permissions were cleared for this discovery.${result.sessionCleanup === 'failed' ? ' The server session could not be closed; check the MCP server.' : ''}`,
      );
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="integration-panel">
      <div className="integration-toolbar">
        <button
          disabled={busy || connections.length >= 30}
          onClick={() => {
            const id = `mcp_${crypto.randomUUID().slice(0, 8)}`;
            setConnections([
              ...connections,
              {
                id,
                name: 'New MCP server',
                url: 'https://example.com/mcp',
                enabled: false,
                secretRef: null,
                agents: [],
                tools: [],
              },
            ]);
            setSelected(id);
          }}
        >
          Add MCP server
        </button>
        <button disabled={busy} onClick={() => void save()}>
          Save connections
        </button>
      </div>
      <RequestNotice message={error} />
      {message && <p role="status">{message}</p>}
      <div className="integration-tabs">
        {connections.map((item) => (
          <button
            key={item.id}
            aria-pressed={selected === item.id}
            onClick={() => setSelected(item.id)}
          >
            {item.name}
            <small>
              {item.enabled ? 'Enabled' : 'Disabled'} · {item.tools.length} tools
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
                maxLength={120}
                value={connection.name}
                onChange={(event) => update({ name: event.target.value })}
              />
            </label>
            <label>
              HTTPS endpoint
              <input
                type="url"
                value={connection.url}
                onChange={(event) => update({ url: event.target.value })}
              />
            </label>
            <CredentialSelect
              label="Bearer token"
              value={connection.secretRef}
              secrets={secrets}
              change={(secretRef) => update({ secretRef })}
            />
            <label>
              <input
                type="checkbox"
                checked={connection.enabled}
                onChange={(event) => update({ enabled: event.target.checked })}
              />{' '}
              Enable connection
            </label>
            <fieldset>
              <legend>Agents with access</legend>
              {agentRoleSchema.options.map((agent) => (
                <label key={agent}>
                  <input
                    type="checkbox"
                    checked={connection.agents.includes(agent)}
                    onChange={(event) =>
                      update({
                        agents: event.target.checked
                          ? [...connection.agents, agent]
                          : connection.agents.filter((item) => item !== agent),
                      })
                    }
                  />
                  {agent === 'cos' ? 'Chief of Staff' : agent}
                </label>
              ))}
            </fieldset>
            <button
              disabled={busy || !mcpConnectionSchema.safeParse(connection).success}
              onClick={() => void discover()}
            >
              Discover tools
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setConnections(connections.filter((item) => item.id !== connection.id));
                setSelected('');
              }}
            >
              Remove connection
            </button>
          </div>
          <div>
            <h2>Tool permissions</h2>
            <p>
              Unknown effects require approval. Enabling a tool makes it available only to the
              agents selected here.
            </p>
            {!connection.tools.length && <p>Discover tools to review their permissions.</p>}
            {connection.tools.map((tool, index) => (
              <div className="integration-tool" key={tool.name}>
                <label>
                  <input
                    type="checkbox"
                    checked={tool.enabled}
                    onChange={(event) =>
                      update({
                        tools: connection.tools.map((item, i) =>
                          i === index ? { ...item, enabled: event.target.checked } : item,
                        ),
                      })
                    }
                  />
                  <strong>{tool.name}</strong>
                </label>
                <p>{tool.description}</p>
                <label>
                  Effect
                  <select
                    value={tool.effect}
                    onChange={(event) =>
                      update({
                        tools: connection.tools.map((item, i) =>
                          i === index
                            ? {
                                ...item,
                                effect: mcpToolSchema.shape.effect.parse(event.target.value),
                              }
                            : item,
                        ),
                      })
                    }
                  >
                    {['unknown', 'read', 'write', 'send', 'delete', 'spend', 'publish'].map(
                      (effect) => (
                        <option key={effect}>{effect}</option>
                      ),
                    )}
                  </select>
                </label>
                <details>
                  <summary>Input schema</summary>
                  <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                </details>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p>Add or select an MCP connection.</p>
      )}
    </section>
  );
}
