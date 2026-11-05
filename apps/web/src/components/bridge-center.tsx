'use client';
import '../lib/validation';
import { useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { agentRoleSchema } from '@sazuz/core/agents';
import { projectSchema } from '@sazuz/core/work';
import { bridgeDeviceSchema, bridgeGrantSchema, bridgeToolSchema } from '@sazuz/core/bridge';
import { api } from '../lib/api';
import { useWorkspaceResource, workspaceError } from '../lib/use-workspace';

const devicesSchema = z.array(bridgeDeviceSchema),
  projectsSchema = z.array(projectSchema);
const secretsSchema = z.array(z.object({ reference: z.string(), name: z.string() }));
const historySchema = z.array(
  z.object({ version: z.number(), enabled: z.boolean(), grant: bridgeGrantSchema.nullable() }),
);
type Device = z.infer<typeof bridgeDeviceSchema>;
type Grant = z.infer<typeof bridgeGrantSchema>;

export function BridgeCenter({ ready }: { ready: boolean }) {
  const devices = useWorkspaceResource('bridge/devices', devicesSchema, ready),
    projects = useWorkspaceResource('projects', projectsSchema, ready),
    secrets = useWorkspaceResource('vault/secrets', secretsSchema, ready);
  const [name, setName] = useState(''),
    [projectId, setProjectId] = useState(''),
    [secretRef, setSecretRef] = useState('');
  const [selected, setSelected] = useState<Device | null>(null),
    [grant, setGrant] = useState<Grant | null>(null);
  const [history, setHistory] = useState<z.infer<typeof historySchema>>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState('');
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await work();
      await devices.refetch();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  function review(device: Device) {
    setSelected(device);
    setHistory([]);
    setGrant(
      device.offered && device.offeredPin
        ? bridgeGrantSchema.parse({
            ...device.offered,
            pin: device.offeredPin,
            folders: device.offered.folders.map((folder) => ({
              ...folder,
              mode: 'read',
              delete: false,
            })),
            commands: [],
            notifications: false,
            agents: [],
            tools: ['local.fs.list', 'local.fs.read'],
            ...(device.grant?.pin === device.offeredPin ? device.grant : {}),
          })
        : null,
    );
  }
  function update(value: Partial<Grant>) {
    setGrant((current) => (current ? { ...current, ...value } : current));
  }
  const failure = error || devices.error || projects.error || secrets.error;
  return (
    <section
      className="setup-card operation-section operation-integration"
      aria-label="Local Bridge"
      id="bridge"
    >
      <h2>Local Bridge</h2>
      <p>
        Connect your laptop over an outbound encrypted connection. Choose folders and fixed commands
        on the laptop, then review the narrower agent grant here.
      </p>
      <p>
        Add <code>local.*</code> to the selected <Link href="/agents">agent’s tools</Link>. Approval
        policy and run budgets still apply. Commands always ask; deletion requires an explicit
        folder grant.
      </p>
      {failure && (
        <p role="alert" className="setup-error">
          {workspaceError(failure, 'Check the Bridge device and try again.')}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void act(async () => {
            await devices.refetch();
            setNotice('Device status refreshed.');
          })
        }
      >
        Refresh Bridge status
      </button>
      {!devices.data?.length && <p>No Bridge devices paired.</p>}
      {devices.data?.map((device) => (
        <article className="durable-card" key={device.id}>
          <h3>{device.name}</h3>
          <p>
            {device.enabled ? (device.online ? 'Online' : 'Offline') : 'Revoked'} · Revision{' '}
            {device.version}
          </p>
          <p style={{ overflowWrap: 'anywhere' }}>
            Device ID: <code>{device.id}</code>
            <br />
            Project ID: <code>{device.projectId}</code>
          </p>
          {device.offeredPin ? (
            <p style={{ overflowWrap: 'anywhere' }}>
              Local pin: <code>{device.offeredPin}</code>
            </p>
          ) : (
            <p>Run the companion to offer local scopes. No agent has device access yet.</p>
          )}
          {device.grant && device.offeredPin !== device.grant.pin && (
            <p role="alert">Local scopes changed. Review the new pin and start a new mission.</p>
          )}
          <div className="button-row">
            <button type="button" disabled={busy || !device.offered} onClick={() => review(device)}>
              Review {device.name} scopes
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api(`bridge/devices/${device.id}/control`, bridgeDeviceSchema, {
                    expectedVersion: device.version,
                    enabled: !device.enabled,
                  });
                  if (selected?.id === device.id) {
                    setSelected(null);
                    setGrant(null);
                  }
                  setNotice(
                    device.enabled
                      ? 'Device revoked. Active calls are stopping.'
                      : 'Device enabled. Start a new mission after reviewing its scopes.',
                  );
                })
              }
            >
              {device.enabled ? 'Revoke device' : 'Enable device'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setSelected(device);
                  setGrant(null);
                  setHistory(await api(`bridge/devices/${device.id}/history`, historySchema));
                })
              }
            >
              History for {device.name}
            </button>
          </div>
        </article>
      ))}
      {selected && history.length > 0 && (
        <details open>
          <summary>Grant history for {selected.name}</summary>
          {history.map((item) => (
            <p key={item.version}>
              Revision {item.version} · {item.enabled ? 'Enabled' : 'Revoked'} ·{' '}
              {item.grant?.agents.join(', ') || 'No agents'}
            </p>
          ))}
        </details>
      )}
      {selected && grant && (
        <form
          aria-label="Bridge grant review"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await api(
                `bridge/devices/${selected.id}`,
                bridgeDeviceSchema,
                { expectedVersion: selected.version, grant },
                'PUT',
              );
              setSelected(null);
              setGrant(null);
              setNotice(
                'Reviewed Bridge grant saved. The companion will reconnect; use a new mission.',
              );
            });
          }}
        >
          <h3>Review {selected.name}</h3>
          <p>
            Compare this pin with <code>sazuz-bridge inspect</code> on the laptop before saving.
            Local paths and command arguments stay on the laptop.
          </p>
          <p style={{ overflowWrap: 'anywhere' }}>
            <code>{grant.pin}</code>
          </p>
          <fieldset>
            <legend>Allowed agents</legend>
            {agentRoleSchema.options.map((role) => (
              <label key={role}>
                <input
                  type="checkbox"
                  checked={grant.agents.includes(role)}
                  onChange={(event) =>
                    update({
                      agents: event.target.checked
                        ? [...grant.agents, role]
                        : grant.agents.filter((item) => item !== role),
                    })
                  }
                />
                {role}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Allowed operations</legend>
            {bridgeToolSchema.options.map((tool) => (
              <label key={tool}>
                <input
                  type="checkbox"
                  checked={grant.tools.includes(tool)}
                  onChange={(event) =>
                    update({
                      tools: event.target.checked
                        ? [...grant.tools, tool]
                        : grant.tools.filter((item) => item !== tool),
                    })
                  }
                />
                {tool}
                {tool === 'local.exec' ? ' · requires approval' : ''}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Folder scopes</legend>
            {selected.offered?.folders.map((folder) => {
              const current = grant.folders.find((item) => item.alias === folder.alias);
              return (
                <div key={folder.alias}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!current}
                      onChange={(event) =>
                        update({
                          folders: event.target.checked
                            ? [...grant.folders, { ...folder, mode: 'read', delete: false }]
                            : grant.folders.filter((item) => item.alias !== folder.alias),
                        })
                      }
                    />
                    Folder {folder.alias}
                  </label>
                  {current && (
                    <>
                      <label>
                        Mode for {folder.alias}
                        <select
                          value={current.mode}
                          onChange={(event) =>
                            update({
                              folders: grant.folders.map((item) =>
                                item.alias === folder.alias
                                  ? {
                                      ...item,
                                      mode: event.target.value === 'write' ? 'write' : 'read',
                                      delete: false,
                                    }
                                  : item,
                              ),
                            })
                          }
                        >
                          <option value="read">Read only</option>
                          {folder.mode === 'write' && <option value="write">Read and write</option>}
                        </select>
                      </label>
                      {folder.delete && (
                        <label>
                          <input
                            type="checkbox"
                            disabled={current.mode !== 'write'}
                            checked={current.delete}
                            onChange={(event) =>
                              update({
                                folders: grant.folders.map((item) =>
                                  item.alias === folder.alias
                                    ? { ...item, delete: event.target.checked }
                                    : item,
                                ),
                              })
                            }
                          />
                          Allow deletion in {folder.alias}
                        </label>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </fieldset>
          {!!selected.offered?.commands.length && (
            <fieldset>
              <legend>Fixed commands</legend>
              {selected.offered.commands.map((alias) => (
                <label key={alias}>
                  <input
                    type="checkbox"
                    checked={grant.commands.includes(alias)}
                    onChange={(event) =>
                      update({
                        commands: event.target.checked
                          ? [...grant.commands, alias]
                          : grant.commands.filter((item) => item !== alias),
                      })
                    }
                  />
                  Command {alias}
                </label>
              ))}
            </fieldset>
          )}
          <label>
            <input
              type="checkbox"
              disabled={!selected.offered?.notifications}
              checked={grant.notifications}
              onChange={(event) => update({ notifications: event.target.checked })}
            />
            Allow native notifications
          </label>
          <label>
            <input
              type="checkbox"
              disabled={selected.offered?.privateOnly}
              checked={grant.privateOnly}
              onChange={(event) => update({ privateOnly: event.target.checked })}
            />
            Keep results on private model routes
          </label>
          <div className="button-row">
            <button type="submit" className="primary" disabled={busy}>
              Save reviewed Bridge grant
            </button>
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setGrant(null);
              }}
            >
              Cancel review
            </button>
          </div>
        </form>
      )}
      <details>
        <summary>Add Bridge device</summary>
        <p>
          Create a random credential of at least 32 characters in your password manager and save it
          in <Link href="/settings?section=vault">Settings → Vault</Link>. Keep its value for the
          laptop’s hidden pairing prompt.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await api('bridge/devices', bridgeDeviceSchema, {
                name,
                projectId,
                secretRef,
              });
              setName('');
              setNotice(
                'Device created with no agent grant. Pair the companion, then review its offered scopes.',
              );
            });
          }}
        >
          <label>
            Bridge device name
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Bridge project
            <select
              required
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">Choose project</option>
              {projects.data?.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Bridge vault credential
            <select
              required
              value={secretRef}
              onChange={(event) => setSecretRef(event.target.value)}
            >
              <option value="">Choose credential</option>
              {secrets.data?.map((secret) => (
                <option key={secret.reference} value={secret.reference}>
                  {secret.name}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" type="submit" disabled={busy}>
            Create Bridge device
          </button>
        </form>
        <ol>
          <li>
            On the laptop, run <code>pnpm --filter @sazuz/bridge-cli start pair</code> from the
            Sazuz distribution.
          </li>
          <li>
            Enter your Sazuz URL with <code>wss://</code> and <code>/bridge</code>, the device and
            project IDs, then the credential in the hidden prompt. Loopback <code>ws://</code> works
            locally.
          </li>
          <li>
            Choose local folders and fixed commands, then run{' '}
            <code>pnpm --filter @sazuz/bridge-cli start run</code>.
          </li>
          <li>Refresh status, compare the local pin, and review the agent grant above.</li>
        </ol>
      </details>
    </section>
  );
}
