'use client';
import { SandboxPanel } from './sandbox-panel';
import { ExecutionDiagnostics } from './execution-diagnostics';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  namespaceSchema,
  settingsDocumentSchema,
  settingsSchemas,
  type SettingsDocument,
  type SettingsNamespace,
} from '@sazuz/config/settings';
import { vaultStatusSchema } from '@sazuz/config/contracts';
import { api, okSchema, secretListSchema, type SecretItem } from '../lib/api';
import { SettingsForm } from './settings-form';
import { SecretControls, VaultControls } from './vault-controls';
import { TwoFactorControls } from './account-controls';
import { GoogleConnections } from './google-connections';
import { StyleProfileEditor } from './style-profile-editor';
import { PasskeyControls } from './passkeys';
import { BackupControls } from './backup-controls';
import { UpdateStatus } from './update-status';
import { PushControls } from './push-controls';
import { SpeechHistory } from './speech-history';
import { WorkHeader } from './work-header';

const sectionDescriptions: Record<SettingsNamespace, string> = {
  general: 'Your workspace identity, address, timezone, and regional preferences.',
  profile: 'Working hours, interruptions, and the way Sazuz writes for you.',
  providers: 'Connect your model providers and local endpoints.',
  models: 'Choose the models that plan, execute, and support your work.',
  budgets: 'Set spending, step, and time limits for autonomous work.',
  security: 'Define which actions run, need your review, or are denied.',
  connectors: 'Connect accounts and choose the access each integration needs.',
  channels: 'Choose where Sazuz delivers updates and requests your attention.',
  speech: 'Configure transcription, spoken answers, and speech providers.',
  memory: 'Control what Sazuz remembers and how long it keeps that context.',
  sandbox: 'Configure isolated code execution and its resource limits.',
  browser: 'Configure browser sessions and inspect execution services.',
  backups: 'Create encrypted snapshots and configure your backup schedule.',
  advanced: 'Agent instructions, updates, and optional telemetry exports.',
};
const sectionGroups = [
  { title: 'Workspace', sections: ['general', 'profile', 'channels', 'speech'] },
  { title: 'Intelligence', sections: ['providers', 'models', 'memory'] },
  { title: 'Controls', sections: ['budgets', 'security', 'sandbox', 'browser'] },
  { title: 'Operations', sections: ['connectors', 'backups', 'advanced'] },
] as const;

const historySchema = z.array(
  z.object({ version: z.number(), value: z.unknown(), changedAt: z.string(), actorId: z.string() }),
);
export function SettingsCenter({
  initialNamespace = 'general',
  oauthOutcome,
}: {
  initialNamespace?: SettingsNamespace;
  oauthOutcome?: 'connected' | 'failed';
}) {
  const [settings, setSettings] = useState<SettingsDocument | null>(null);
  const [namespace, setNamespace] = useState<SettingsNamespace>(initialNamespace);
  const [draft, setDraft] = useState<unknown>(null);
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [vault, setVault] = useState<z.infer<typeof vaultStatusSchema> | null>(null);
  const [history, setHistory] = useState<z.infer<typeof historySchema>>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const loadGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const session = await api(
      'auth/get-session',
      z.object({ user: z.object({ id: z.string() }) }).nullable(),
    );
    if (!session) {
      window.location.assign('/login');
      return;
    }
    const [document, secretItems, vaultStatus, versions] = await Promise.all([
      api('settings', settingsDocumentSchema),
      api('vault/secrets', secretListSchema),
      api('vault/status', vaultStatusSchema),
      api(`settings/${namespace}/history`, historySchema),
    ]);
    if (generation !== loadGeneration.current) return;
    window.dispatchEvent(
      new CustomEvent('sazuz:appearance', { detail: document.general.value.theme }),
    );
    setSettings(document);
    setDraft(document[namespace].value);
    setSecrets(secretItems);
    setVault(vaultStatus);
    setHistory(versions);
  }, [namespace]);
  useEffect(() => {
    void refresh().catch((cause: unknown) =>
      setMessage(cause instanceof Error ? cause.message : 'Could not load settings.'),
    );
  }, [refresh]);
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await operation();
      await refresh();
      setMessage('Saved. Changes are applied to running services automatically.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not save changes.');
    } finally {
      setBusy(false);
    }
  }
  function selectSection(name: SettingsNamespace) {
    if (name === namespace) return;
    setDraft(null);
    setNamespace(name);
    window.history.replaceState(null, '', `/settings?section=${name}`);
    setMessage('');
  }
  return (
    <div className="setup-shell work-shell settings-shell">
      <WorkHeader
        current="Settings"
        controls={
          <button
            className="secondary"
            onClick={() => {
              void api('auth/sign-out', okSchema, {})
                .then(() => window.location.assign('/login'))
                .catch(() => setMessage('Could not sign out. Try again.'));
            }}
          >
            Sign out
          </button>
        }
      />
      <main id="work-content" className="settings-content" tabIndex={-1}>
        <header className="settings-page-heading">
          <div>
            <p className="eyebrow">WORKSPACE</p>
            <h1>Settings Center</h1>
            <p>Configure your workspace, models, and controls.</p>
          </div>
          <span className="settings-section-count">{namespaceSchema.options.length} sections</span>
        </header>
        <div className="settings-mobile-navigation">
          <div className="setup-field">
            <label htmlFor="settings-section-selector">Settings section</label>
            <select
              id="settings-section-selector"
              value={namespace}
              onChange={(event) => {
                const section = namespaceSchema.safeParse(event.target.value);
                if (section.success) selectSection(section.data);
              }}
            >
              {sectionGroups.map((group) => (
                <optgroup label={group.title} key={group.title}>
                  {group.sections.map((name) => (
                    <option key={name} value={name}>
                      {name.charAt(0).toUpperCase() + name.slice(1)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <a href="#vault">Vault and account</a>
            <a href="/agents">Agents and permissions</a>
          </div>
        </div>
        <div className="setup-layout settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            {sectionGroups.map((group) => (
              <div className="settings-nav-group" key={group.title}>
                <p>{group.title}</p>
                {group.sections.map((name) => (
                  <button
                    key={name}
                    aria-current={name === namespace ? 'page' : undefined}
                    onClick={() => selectSection(name)}
                  >
                    {name.charAt(0).toUpperCase() + name.slice(1)}
                  </button>
                ))}
              </div>
            ))}
            <div className="settings-nav-links">
              <a href="#vault">Vault and account</a>
              <a href="/agents">Agents and permissions</a>
            </div>
          </nav>
          <section className="setup-card settings-editor" aria-labelledby="settings-section-title">
            <header className="settings-editor-heading">
              <div>
                <h2 id="settings-section-title">
                  {namespace.charAt(0).toUpperCase() + namespace.slice(1)}
                </h2>
                <p>{sectionDescriptions[namespace]}</p>
              </div>
              {settings && (
                <span className="settings-version">Version {settings[namespace].version}</span>
              )}
            </header>
            {namespace === 'connectors' && oauthOutcome && (
              <p
                className={oauthOutcome === 'connected' ? 'setup-notice' : 'setup-error'}
                role="status"
              >
                {oauthOutcome === 'connected'
                  ? 'Google account connected. The credential is encrypted in your vault.'
                  : 'Google authorization could not complete. Check the account settings and try connecting again.'}
              </p>
            )}
            {namespace === 'backups' && (
              <BackupControls ready={settings !== null && draft !== null && !busy} />
            )}
            {namespace === 'speech' && <SpeechHistory />}
            {namespace === 'channels' && <PushControls key={settings?.channels.version} />}
            {namespace === 'advanced' && <UpdateStatus />}
            {namespace === 'sandbox' && <SandboxPanel />}
            {namespace === 'browser' && <ExecutionDiagnostics />}
            {namespace === 'channels' && (
              <p className="setup-notice">
                Save the Telegram bot credential here, then{' '}
                <a href="/automations#telegram">pair your Telegram account</a>. Urgent and digest
                delivery follow your channel choices.
              </p>
            )}
            {namespace === 'connectors' && (
              <p className="setup-notice">
                Connection credentials stay in the vault.{' '}
                <a href="/connectors">Browse connectors and their scopes</a>.{' '}
                <a href="/automations">Use configured accounts in automations</a>; external changes
                follow your approval policy.
              </p>
            )}
            {namespace === 'profile' && (
              <p className="setup-notice">
                Quiet hours and digest times apply in your configured timezone.{' '}
                <a href="/automations#notifications">Review notifications and digests</a>.
              </p>
            )}
            {namespace === 'profile' && <StyleProfileEditor />}
            {namespace === 'security' && (
              <p className="setup-notice">
                Your preset applies to proposed tool actions.{' '}
                <a href="/approvals">Review pending approvals</a>.
              </p>
            )}
            {namespace === 'budgets' && (
              <p className="setup-notice">
                These caps apply to new runs.{' '}
                <a href="/missions">Review missions and extend a stopped run’s allowance</a>.
              </p>
            )}
            {['providers', 'models'].includes(namespace) && (
              <p className="setup-notice">
                <a href="/models">Discover models, test connections, and edit token prices</a>. Role
                and provider changes apply to your next chat request.
              </p>
            )}
            {settings && draft !== null ? (
              <>
                <SecretControls secrets={secrets} onChange={setSecrets} />
                {namespace === 'connectors' && <GoogleConnections settings={settings} />}
                <form
                  className="settings-editor-form"
                  aria-busy={busy}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      const result = settingsSchemas[namespace].safeParse(draft);
                      if (!result.success)
                        throw new Error(
                          `Check these fields: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}.`,
                        );
                      await api(
                        `settings/${namespace}`,
                        z.object({ version: z.number() }),
                        { value: result.data, expectedVersion: settings[namespace].version },
                        'PUT',
                      );
                    });
                  }}
                >
                  <SettingsForm
                    namespace={namespace}
                    value={draft}
                    onChange={setDraft}
                    secrets={secrets}
                  />
                  <div className="settings-save-bar">
                    <p>Changes are validated, versioned, and recorded in history.</p>
                    <button disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
                  </div>
                </form>
                <details className="setup-details">
                  <summary>Version history ({history.length})</summary>
                  {history.map((entry) => (
                    <article className="history-entry" key={entry.version}>
                      <strong>Version {entry.version}</strong> ·{' '}
                      {new Date(entry.changedAt).toLocaleString()}
                      <details>
                        <summary>View saved values</summary>
                        <pre>{JSON.stringify(entry.value, null, 2)}</pre>
                      </details>
                      {entry.version !== settings[namespace].version && (
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => {
                            void run(async () => {
                              await api(
                                `settings/${namespace}/rollback`,
                                z.object({ version: z.number() }),
                                {
                                  version: entry.version,
                                  expectedVersion: settings[namespace].version,
                                },
                              );
                            });
                          }}
                        >
                          Restore version {entry.version}
                        </button>
                      )}
                    </article>
                  ))}
                </details>
              </>
            ) : (
              <p className="settings-loading" role="status">
                Loading settings…
              </p>
            )}
            {message && (
              <p role="status" className="setup-notice">
                {message}
              </p>
            )}
            <section id="vault" className="account-section">
              <p className="eyebrow">ACCESS & RECOVERY</p>
              <h2>Vault and account</h2>
              {vault && <VaultControls status={vault} refresh={refresh} />}
              <TwoFactorControls />
              <PasskeyControls />
            </section>
          </section>
        </div>
      </main>
    </div>
  );
}
