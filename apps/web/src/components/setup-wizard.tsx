'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { setupStatusSchema, type SetupStatus } from '@sazuz/config/contracts';
import { settingsSchemas, type SettingsNamespace } from '@sazuz/config/settings';
import { healthSchema } from '@sazuz/core/health';
import { api, okSchema, secretListSchema, type SecretItem } from '../lib/api';
import { LoginForm, TwoFactorControls } from './account-controls';
import { VaultControls, SecretControls } from './vault-controls';
import { SettingsForm } from './settings-form';
import { StyleProfileEditor } from './style-profile-editor';
import { ExecutionDiagnostics } from './execution-diagnostics';
import { PasskeyControls } from './passkeys';
import { RestoreBackup } from './backup-controls';
import { SazuzMark } from './icons';

const titles = [
  'Enter your setup token',
  'Welcome to Sazuz',
  'Create your admin account',
  'Protect your credentials',
  'AI providers',
  'Models and router',
  'Set your budgets',
  'About you and Calm Mode',
  'Connect accounts',
  'Where to reach you',
  'Choose your safety preset',
  'Choose your agent team',
  'Review and launch',
];
const namespaces: Partial<Record<number, SettingsNamespace>> = {
  1: 'general',
  4: 'providers',
  5: 'models',
  6: 'budgets',
  7: 'profile',
  8: 'connectors',
  9: 'channels',
  10: 'security',
  11: 'advanced',
};
const notes: Partial<Record<number, string>> = {
  4: 'Add at least one provider or local endpoint. After setup, use Models to discover and test available models.',
  5: 'Choose the models for planning, execution and Fast background tasks. The optional Embedding role enables hybrid knowledge retrieval.',
  7: 'Set working hours, quiet hours and digest limits. You can also preview and review a writing style from samples.',
  8: 'Connect Gmail, IMAP/SMTP, Google Calendar or GitHub with the scopes you need. Credentials stay in the vault.',
  9: 'Choose delivery preferences. After setup, pair Telegram in Automations to receive notifications and handle approvals.',
  10: 'Read actions are allowed by default. Consequential actions follow your Policy Engine rules; spending is denied by default.',
  11: 'The current team includes the Chief of Staff with sequential Researcher, Comms, Coder, Analyst and Operator tasks.',
};

export function SetupWizard() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [draft, setDraft] = useState<unknown>(null);
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState('Checking database and worker…');
  const loadGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const next = await api('setup/status', setupStatusSchema);
    if (generation !== loadGeneration.current) return;
    if (next.completed) {
      window.location.assign('/');
      return;
    }
    setStatus(next);
    const namespace = namespaces[next.currentStep];
    setDraft(namespace && next.settings ? next.settings[namespace].value : null);
    if (next.authenticated) setSecrets(await api('vault/secrets', secretListSchema));
  }, []);
  useEffect(() => {
    void refresh().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : 'Could not load setup.'),
    );
  }, [refresh]);
  useEffect(() => {
    void api('health', healthSchema)
      .then((value) =>
        setHealth(
          `Database: ${value.services.database.status}. Worker: ${value.services.worker.status}.`,
        ),
      )
      .catch(() => setHealth('System health needs attention. Open the health page for details.'));
  }, []);
  async function advance(next: number, save: boolean) {
    if (!status) return;
    setBusy(true);
    setError('');
    try {
      const namespace = namespaces[status.currentStep];
      if (save && namespace && status.settings) {
        const parsed = settingsSchemas[namespace].safeParse(draft);
        if (!parsed.success)
          throw new Error(
            `Check these fields: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}.`,
          );
        await api('setup/step', okSchema, {
          step: next,
          namespace,
          value: parsed.data,
          expectedVersion: status.settings[namespace].version,
        });
      } else await api('setup/step', okSchema, { step: next });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this screen.');
    } finally {
      setBusy(false);
    }
  }
  const step = status?.gateOpen ? status.currentStep : 0;
  const namespace = namespaces[step];
  return (
    <main className="setup-shell onboarding-shell">
      <header className="setup-header">
        <a href="/" className="setup-brand">
          <SazuzMark />
          <span className="setup-brand-name">
            Sazuz<span>Workspace setup</span>
          </span>
        </a>
        <a className="setup-health-link" href="/health">
          System health ↗
        </a>
      </header>
      <div className="setup-layout">
        <aside className="setup-progress">
          <p className="eyebrow">SET UP YOUR WORKSPACE</p>
          <p className="setup-progress-intro">Make Sazuz yours.</p>
          <ol>
            {titles.map((title, index) => (
              <li
                key={title}
                aria-current={step === index ? 'step' : undefined}
                data-complete={index < step || undefined}
              >
                <span>{index < step ? '✓' : String(index).padStart(2, '0')}</span>
                {title}
              </li>
            ))}
          </ol>
        </aside>
        <section className="setup-card">
          <div className="setup-step-heading">
            <p className="eyebrow">STEP {step} OF 12</p>
            <progress value={step} max={12} aria-label="Setup progress" />
          </div>
          <h1>{titles[step]}</h1>
          {status?.gateOpen && step === 1 && <ExecutionDiagnostics setup />}
          {status?.gateOpen && !status.adminCreated && step === 1 && <RestoreBackup />}
          {!status ? (
            <p role="status">Loading setup…</p>
          ) : !status.gateOpen ? (
            <>
              <p>
                Enter the one-time token shown by the installer. It is also stored privately on the
                Sazuz host.
              </p>
              <form
                className="setup-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const token = new FormData(form).get('token');
                  setBusy(true);
                  setError('');
                  void api('setup/gate', okSchema, { token })
                    .then(async () => {
                      form.reset();
                      await refresh();
                    })
                    .catch((cause: unknown) =>
                      setError(
                        cause instanceof Error ? cause.message : 'Token verification failed.',
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                <label className="setup-field">
                  Setup token
                  <input type="password" name="token" autoComplete="off" required />
                </label>
                <button disabled={busy}>Unlock setup</button>
              </form>
            </>
          ) : status.adminCreated && !status.authenticated ? (
            <>
              <p>Sign in to resume your saved setup.</p>
              <LoginForm onSignedIn={refresh} />
            </>
          ) : (
            <>
              {step === 1 && (
                <>
                  <p>Make this workspace yours. Every choice can be changed later in Settings.</p>
                  <p className="setup-notice" role="status">
                    {health}
                  </p>
                  <p>Continue below to start fresh, or restore an encrypted snapshot above.</p>
                </>
              )}
              {step === 2 && (
                <>
                  <p>This account controls your workspace and its settings.</p>
                  {status.adminCreated ? (
                    <>
                      <p>Your admin account is ready.</p>
                      <TwoFactorControls />
                    </>
                  ) : (
                    <LoginForm create onSignedIn={refresh} />
                  )}
                </>
              )}
              {step === 3 && (
                <>
                  <VaultControls status={status.vault} refresh={refresh} />
                  <TwoFactorControls />
                  <PasskeyControls />
                </>
              )}
              {notes[step] && <p className="setup-notice">{notes[step]}</p>}
              {step === 7 && <StyleProfileEditor />}
              {[4, 8, 9].includes(step) && (
                <SecretControls secrets={secrets} onChange={setSecrets} />
              )}
              {namespace && draft !== null && (
                <form
                  id="wizard-settings"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void advance(step + 1, true);
                  }}
                >
                  <SettingsForm
                    namespace={namespace}
                    value={draft}
                    onChange={setDraft}
                    secrets={secrets}
                  />
                </form>
              )}
              {step === 12 && (
                <>
                  <p>
                    Your choices are saved. Launch completes setup and permanently disables the
                    setup token.
                  </p>
                  <dl className="setup-review">
                    <dt>Workspace</dt>
                    <dd>{status.settings?.general.value.instanceName}</dd>
                    <dt>Providers</dt>
                    <dd>
                      {status.settings?.providers.value.items
                        .map((provider) => provider.name)
                        .join(', ') || 'No providers configured'}
                    </dd>
                    <dt>Monthly budget</dt>
                    <dd>${status.settings?.budgets.value.monthlyUsd}</dd>
                    <dt>Vault</dt>
                    <dd>
                      {status.vault.mode},{' '}
                      {status.vault.recoveryConfirmed
                        ? 'recovery kit confirmed'
                        : 'recovery confirmation needed'}
                    </dd>
                    <dt>Safety</dt>
                    <dd>{status.settings?.security.value.preset}</dd>
                    <dt>System health</dt>
                    <dd>{health}</dd>
                  </dl>
                  <p>
                    After launch, open your workspace to start work and manage your configuration.
                  </p>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void api('setup/complete', okSchema, {})
                        .then(() => window.location.assign('/'))
                        .catch((cause: unknown) => {
                          setError(
                            cause instanceof Error ? cause.message : 'Could not finish setup.',
                          );
                          setBusy(false);
                        });
                    }}
                  >
                    Launch Sazuz
                  </button>
                </>
              )}
              <nav className="setup-actions" aria-label="Wizard navigation">
                {step > 1 && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      void advance(step - 1, false);
                    }}
                  >
                    Back
                  </button>
                )}
                {(step !== 2 || status.adminCreated) && step !== 12 && (
                  <button
                    form={namespace ? 'wizard-settings' : undefined}
                    type={namespace ? 'submit' : 'button'}
                    disabled={busy || (step === 3 && !status.vault.recoveryConfirmed)}
                    onClick={
                      namespace
                        ? undefined
                        : () => {
                            void advance(step + 1, false);
                          }
                    }
                  >
                    {busy ? 'Saving…' : 'Save and continue'}
                  </button>
                )}
                {[5, 6, 7, 8, 9, 10, 11].includes(step) && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      void advance(step + 1, false);
                    }}
                  >
                    Skip for now
                  </button>
                )}
              </nav>
            </>
          )}
          {error && (
            <p role="alert" className="setup-error">
              {error}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
