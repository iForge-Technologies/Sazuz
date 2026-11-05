'use client';
import '../lib/validation';
import { useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { projectSchema } from '@sazuz/core/work';
import { agentRoleSchema } from '@sazuz/core/agents';
import {
  mcpCatalogueSchema,
  mcpServerSchema,
  mcpClientSchema,
  mcpTransportSchema,
  mcpEffectSchema,
  type mcpPermissionSchema,
  mcpIncomingToolSchema,
} from '@sazuz/core/mcp';
import { api } from '../lib/api';
import { useWorkspaceResource, workspaceError } from '../lib/use-workspace';

const serversSchema = z.array(mcpServerSchema),
  clientsSchema = z.array(mcpClientSchema),
  projectsSchema = z.array(projectSchema);
const secretsSchema = z.array(z.object({ reference: z.string(), name: z.string() }));
type Permission = z.infer<typeof mcpPermissionSchema>;
type Installation = z.infer<typeof mcpServerSchema>;

export function McpCenter({ ready }: { ready: boolean }) {
  const servers = useWorkspaceResource('mcp/servers', serversSchema, ready),
    clients = useWorkspaceResource('mcp/clients', clientsSchema, ready);
  const projects = useWorkspaceResource('projects', projectsSchema, ready),
    secrets = useWorkspaceResource('vault/secrets', secretsSchema, ready);
  const [projectId, setProjectId] = useState(''),
    [name, setName] = useState(''),
    [kind, setKind] = useState<'http' | 'stdio'>('http');
  const [url, setUrl] = useState(''),
    [secretRef, setSecretRef] = useState(''),
    [image, setImage] = useState(''),
    [command, setCommand] = useState(''),
    [args, setArgs] = useState('[]');
  const [selected, setSelected] = useState<Installation | null>(null),
    [catalogue, setCatalogue] = useState<z.infer<typeof mcpCatalogueSchema> | null>(null),
    [permissions, setPermissions] = useState<Permission[]>([]);
  const [history, setHistory] = useState<Installation[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState('');
  const [clientName, setClientName] = useState(''),
    [clientProject, setClientProject] = useState(''),
    [clientSecret, setClientSecret] = useState('');
  const [clientTools, setClientTools] = useState<z.infer<typeof mcpIncomingToolSchema>[]>([
      'get_mission_status',
    ]),
    [allowPrivate, setAllowPrivate] = useState(false);
  const transport = () =>
    mcpTransportSchema.parse(
      kind === 'http'
        ? { kind, url, secretRef: secretRef || null }
        : { kind, image, command, args: JSON.parse(args) as unknown },
    );
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await work();
      await Promise.all([servers.refetch(), clients.refetch()]);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  function choose(item: Installation | null) {
    setSelected(item);
    setCatalogue(item?.configuration.catalogue ?? null);
    setPermissions(item?.configuration.permissions ?? []);
    setHistory([]);
    setName(item?.configuration.name ?? '');
    setProjectId(item?.projectId ?? '');
    const saved = item?.configuration.transport;
    setKind(saved?.kind ?? 'http');
    setUrl(saved?.kind === 'http' ? saved.url : '');
    setSecretRef(saved?.kind === 'http' ? (saved.secretRef ?? '') : '');
    setImage(saved?.kind === 'stdio' ? saved.image : '');
    setCommand(saved?.kind === 'stdio' ? saved.command : '');
    setArgs(saved?.kind === 'stdio' ? JSON.stringify(saved.args) : '[]');
  }
  function changePermission(tool: string, update: Partial<Permission>) {
    setPermissions((items) =>
      items.map((entry) => (entry.tool === tool ? { ...entry, ...update } : entry)),
    );
  }
  const failure = error || servers.error || clients.error || projects.error || secrets.error;
  return (
    <section
      className="setup-card operation-section operation-integration"
      aria-label="MCP integrations"
      id="mcp"
    >
      <h2>MCP servers</h2>
      <p>
        Inspect a server, review what each tool may do, and select its agents. Unmapped tools
        require approval. Server annotations are hints; they never grant permission.
      </p>
      <p>
        In <Link href="/agents">Agents</Link>, add the installation’s tool prefix to the selected
        agents. Current agent restrictions and your approval policy still apply.
      </p>
      {failure && (
        <p className="setup-error" role="alert">
          {workspaceError(failure, 'Check the MCP configuration and try again.')}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!servers.data?.length && <p>No MCP servers installed.</p>}
      {servers.data?.map((server) => (
        <article className="durable-card" key={server.id}>
          <h3>{server.configuration.name}</h3>
          <p>
            Revision {server.version} · {server.configuration.enabled ? 'Enabled' : 'Disabled'} ·{' '}
            {server.configuration.catalogue.serverVersion}
          </p>
          {server.warning && <p role="alert">{server.warning}</p>}
          <p style={{ overflowWrap: 'anywhere' }}>
            Agent tool prefix: <code>mcp.{server.id.toLowerCase()}.*</code>
          </p>
          <button disabled={busy} onClick={() => choose(server)}>
            Review {server.configuration.name}
          </button>{' '}
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api(`mcp/servers/${server.id}/control`, mcpServerSchema, {
                  expectedVersion: server.version,
                  enabled: !server.configuration.enabled,
                });
                setNotice('Installation updated. Existing runs keep their original pin.');
              })
            }
          >
            {server.configuration.enabled ? 'Disable' : 'Enable'}
          </button>{' '}
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                setHistory(
                  await api(`mcp/servers/${server.id}/history`, serversSchema, undefined, 'GET'),
                );
              })
            }
          >
            History
          </button>
        </article>
      ))}
      {history.length > 0 && (
        <details open>
          <summary>Installation history</summary>
          <ul>
            {history.map((entry) => (
              <li key={entry.version}>
                {entry.configuration.name} · revision {entry.version} ·{' '}
                {entry.configuration.enabled ? 'enabled' : 'disabled'} · server{' '}
                {entry.configuration.catalogue.serverVersion}
              </li>
            ))}
          </ul>
        </details>
      )}
      <details open={selected !== null || !servers.data?.length}>
        <summary>{selected ? 'Review installation' : 'Add MCP server'}</summary>
        {selected && (
          <button disabled={busy} onClick={() => choose(null)}>
            New installation
          </button>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              if (!catalogue) return;
              await api(
                selected ? `mcp/servers/${selected.id}` : 'mcp/servers',
                mcpServerSchema,
                {
                  projectId,
                  name,
                  transport: transport(),
                  expectedPin: catalogue.sha256,
                  permissions,
                  expectedVersion: selected?.version ?? 0,
                },
                selected ? 'PUT' : 'POST',
              );
              choose(null);
              setNotice('MCP installation saved with the reviewed permissions and pin.');
            });
          }}
        >
          <label className="setup-field">
            MCP name
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="setup-field">
            MCP project
            <select
              required
              value={projectId}
              disabled={selected !== null}
              onChange={(event) => {
                setProjectId(event.target.value);
                setCatalogue(null);
              }}
            >
              <option value="">Choose project</option>
              {projects.data?.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="setup-field">
            Transport
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value === 'stdio' ? 'stdio' : 'http');
                setCatalogue(null);
              }}
            >
              <option value="http">Streamable HTTP</option>
              <option value="stdio">Sandboxed stdio image</option>
            </select>
          </label>
          {kind === 'http' ? (
            <>
              <label className="setup-field">
                HTTPS MCP endpoint
                <input
                  required
                  type="url"
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setCatalogue(null);
                  }}
                  placeholder="https://mcp.example.com/mcp"
                />
              </label>
              <label className="setup-field">
                MCP bearer credential
                <select
                  value={secretRef}
                  onChange={(event) => {
                    setSecretRef(event.target.value);
                    setCatalogue(null);
                  }}
                >
                  <option value="">No authentication</option>
                  {secrets.data?.map((secret) => (
                    <option key={secret.reference} value={secret.reference}>
                      {secret.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <>
              <p>
                Preload a reviewed image on the Docker host. It runs without networking or host
                mounts. Arguments must contain no credentials.
              </p>
              <label className="setup-field">
                Image with SHA-256 digest
                <input
                  required
                  value={image}
                  onChange={(event) => {
                    setImage(event.target.value);
                    setCatalogue(null);
                  }}
                  placeholder="registry.example/mcp@sha256:…"
                />
              </label>
              <label className="setup-field">
                Executable inside image
                <input
                  required
                  value={command}
                  onChange={(event) => {
                    setCommand(event.target.value);
                    setCatalogue(null);
                  }}
                  placeholder="/usr/local/bin/node"
                />
              </label>
              <label className="setup-field">
                Arguments (JSON array)
                <textarea
                  value={args}
                  onChange={(event) => {
                    setArgs(event.target.value);
                    setCatalogue(null);
                  }}
                />
              </label>
            </>
          )}
          <button
            type="button"
            disabled={busy || !projectId}
            onClick={() =>
              void act(async () => {
                const found = await api('mcp/inspect', mcpCatalogueSchema, {
                  projectId,
                  transport: transport(),
                });
                setCatalogue(found);
                setPermissions(
                  found.tools.map(
                    (tool) =>
                      permissions.find((entry) => entry.tool === tool.name) ?? {
                        tool: tool.name,
                        effect: null,
                        agents: [],
                        enabled: true,
                        moneyMovement: false,
                      },
                  ),
                );
                setNotice(
                  'Inspect each tool below before saving. The displayed pin will be checked again.',
                );
              })
            }
          >
            Inspect tools
          </button>
          {catalogue && (
            <>
              <p>
                {catalogue.serverName} · version {catalogue.serverVersion} ·{' '}
                {catalogue.tools.length} tools
              </p>
              <details>
                <summary>Reviewed catalogue pin</summary>
                <code style={{ overflowWrap: 'anywhere' }}>{catalogue.sha256}</code>
              </details>
              {catalogue.tools.map((tool) => {
                const permission = permissions.find((entry) => entry.tool === tool.name)!;
                return (
                  <fieldset key={tool.name}>
                    <legend>{tool.name}</legend>
                    <p>{tool.description}</p>
                    <p>Untrusted annotation hints: {JSON.stringify(tool.annotations)}</p>
                    <label className="setup-field">
                      Effect for {tool.name}
                      <select
                        value={permission.effect ?? ''}
                        onChange={(event) =>
                          changePermission(tool.name, {
                            effect: event.target.value
                              ? mcpEffectSchema.parse(event.target.value)
                              : null,
                          })
                        }
                      >
                        <option value="">Unmapped — write, ask</option>
                        {mcpEffectSchema.options.map((effect) => (
                          <option key={effect} value={effect}>
                            {effect}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="setup-check">
                      <input
                        type="checkbox"
                        checked={permission.enabled}
                        onChange={(event) =>
                          changePermission(tool.name, { enabled: event.target.checked })
                        }
                      />
                      Enable {tool.name}
                    </label>
                    <label className="setup-check">
                      <input
                        type="checkbox"
                        checked={permission.moneyMovement}
                        onChange={(event) =>
                          changePermission(tool.name, { moneyMovement: event.target.checked })
                        }
                      />
                      This tool moves money or trades securities (blocked)
                    </label>
                    <fieldset>
                      <legend>Agents allowed to use {tool.name}</legend>
                      {agentRoleSchema.options
                        .filter((agent) => agent !== 'auditor')
                        .map((agent) => (
                          <label className="setup-check" key={agent}>
                            <input
                              type="checkbox"
                              checked={permission.agents.includes(agent)}
                              onChange={(event) =>
                                changePermission(tool.name, {
                                  agents: event.target.checked
                                    ? [...permission.agents, agent]
                                    : permission.agents.filter((role) => role !== agent),
                                })
                              }
                            />
                            {agent}
                          </label>
                        ))}
                    </fieldset>
                    <details>
                      <summary>Input schema for {tool.name}</summary>
                      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                        {JSON.stringify(tool.inputSchema, null, 2)}
                      </pre>
                    </details>
                  </fieldset>
                );
              })}
              <button disabled={busy || !projectId || !name.trim()}>
                Save reviewed MCP installation
              </button>
            </>
          )}
        </form>
      </details>
      <h2>Incoming MCP clients</h2>
      <p>
        Use this Sazuz site’s <code>/mcp</code> endpoint with Streamable HTTP and an Authorization:
        Bearer header. Create a random credential of at least 32 characters in the{' '}
        <Link href="/settings?section=vault">vault</Link> first and enter the same value in your MCP
        client. The API never reveals it.
      </p>
      {clients.data?.map((client) => (
        <article className="durable-card" key={client.id}>
          <h3>{client.name}</h3>
          <p>
            {client.enabled ? 'Enabled' : 'Revoked'} · {client.tools.join(', ')}
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api(`mcp/clients/${client.id}/control`, mcpClientSchema, {
                  expectedVersion: client.version,
                  enabled: !client.enabled,
                });
                setNotice('Client access updated.');
              })
            }
          >
            {client.enabled ? 'Revoke client' : 'Enable client'}
          </button>
        </article>
      ))}
      <details>
        <summary>Add scoped MCP client</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await api('mcp/clients', mcpClientSchema, {
                name: clientName,
                projectId: clientProject,
                secretRef: clientSecret,
                tools: clientTools,
                allowPrivate,
              });
              setClientName('');
              setClientSecret('');
              setNotice(
                'Scoped client saved. Configure its bearer header in your MCP application.',
              );
            });
          }}
        >
          <label className="setup-field">
            Client name
            <input
              required
              value={clientName}
              maxLength={120}
              onChange={(event) => setClientName(event.target.value)}
            />
          </label>
          <label className="setup-field">
            Client project
            <select
              required
              value={clientProject}
              onChange={(event) => setClientProject(event.target.value)}
            >
              <option value="">Choose project</option>
              {projects.data?.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="setup-field">
            Client vault credential
            <select
              required
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
            >
              <option value="">Choose credential</option>
              {secrets.data?.map((secret) => (
                <option key={secret.reference} value={secret.reference}>
                  {secret.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>Delegated tools</legend>
            {mcpIncomingToolSchema.options.map((tool) => (
              <label className="setup-check" key={tool}>
                <input
                  type="checkbox"
                  checked={clientTools.includes(tool)}
                  onChange={(event) =>
                    setClientTools(
                      event.target.checked
                        ? [...clientTools, tool]
                        : clientTools.filter((name) => name !== tool),
                    )
                  }
                />
                {tool}
              </label>
            ))}
          </fieldset>
          <label className="setup-check">
            <input
              type="checkbox"
              checked={allowPrivate}
              onChange={(event) => setAllowPrivate(event.target.checked)}
            />
            Allow access when this project is private
          </label>
          <button disabled={busy || !clientTools.length}>Save MCP client</button>
        </form>
      </details>
    </section>
  );
}
