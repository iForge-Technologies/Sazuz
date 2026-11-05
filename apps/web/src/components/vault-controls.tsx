'use client';
import { useState } from 'react';
import { z } from 'zod';
import { recoveryResponseSchema, vaultStatusSchema } from '@sazuz/config/contracts';
import { api, okSchema, secretListSchema, type SecretItem } from '../lib/api';

export function VaultControls({
  status,
  refresh,
}: {
  status: z.infer<typeof vaultStatusSchema>;
  refresh: () => Promise<void>;
}) {
  const [kit, setKit] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Vault operation failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="vault-controls" aria-label="Vault controls">
      <div className="vault-status-line">
        <span className="vault-status" data-locked={status.locked || !status.initialized}>
          {!status.initialized
            ? 'Vault not created'
            : status.locked
              ? 'Vault locked'
              : 'Vault unlocked'}
        </span>
        {status.recoveryConfirmed && <span>Recovery kit confirmed</span>}
      </div>
      <p>
        {!status.initialized
          ? 'Choose a passphrase to protect your credentials.'
          : status.locked
            ? 'Your vault is locked. Unlock it to use or add credentials.'
            : `Your vault is unlocked. Restart mode: ${status.mode}.`}
      </p>
      {!status.initialized || status.locked ? (
        <form
          className="setup-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const values = new FormData(form);
            void run(async () => {
              if (!status.initialized) {
                const response = await api('vault/initialize', recoveryResponseSchema, {
                  passphrase: values.get('passphrase'),
                  mode: values.get('mode'),
                });
                setKit(response.recoveryKit.text);
                setDownloaded(false);
              } else
                await api('vault/unlock', vaultStatusSchema, {
                  passphrase: values.get('passphrase'),
                });
              form.reset();
            });
          }}
        >
          <label className="setup-field">
            Vault passphrase
            <input
              name="passphrase"
              type="password"
              minLength={12}
              maxLength={256}
              required
              autoComplete={status.initialized ? 'current-password' : 'new-password'}
            />
          </label>
          {!status.initialized && (
            <label className="setup-field">
              Unlock mode
              <select name="mode" defaultValue="auto">
                <option value="auto">Auto — unattended restarts</option>
                <option value="strict">Strict — passphrase after every restart</option>
              </select>
              <small>
                Auto mode keeps a private unlock key on this host. Root access to the host can
                unlock the vault.
              </small>
            </label>
          )}
          <button disabled={busy}>{status.initialized ? 'Unlock vault' : 'Create vault'}</button>
        </form>
      ) : (
        <>
          {status.recoveryConfirmed && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                void run(async () => {
                  await api('vault/lock', vaultStatusSchema, {});
                });
              }}
            >
              Lock vault
            </button>
          )}
          {!kit && (
            <details className="setup-details" open={!status.recoveryConfirmed}>
              <summary>
                {status.recoveryConfirmed
                  ? 'Recovery and unlock mode'
                  : 'Create a replacement recovery kit'}
              </summary>
              <p>A replacement kit revokes the previous recovery key.</p>
              <form
                className="setup-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const values = new FormData(form);
                  void run(async () => {
                    const response = await api('vault/recovery', recoveryResponseSchema, {
                      passphrase: values.get('passphrase'),
                    });
                    setKit(response.recoveryKit.text);
                    setDownloaded(false);
                    form.reset();
                  });
                }}
              >
                <label className="setup-field">
                  Vault passphrase or recovery key
                  <input type="password" name="passphrase" required autoComplete="off" />
                </label>
                <button disabled={busy}>Generate recovery kit</button>
              </form>
              <form
                className="setup-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const values = new FormData(form);
                  void run(async () => {
                    await api('vault/mode', vaultStatusSchema, {
                      passphrase: values.get('passphrase'),
                      mode: values.get('mode'),
                    });
                    form.reset();
                  });
                }}
              >
                <label className="setup-field">
                  Vault passphrase
                  <input
                    type="password"
                    name="passphrase"
                    required
                    autoComplete="current-password"
                  />
                </label>
                <label className="setup-field">
                  Restart mode
                  <select name="mode" defaultValue={status.mode ?? 'auto'}>
                    <option value="auto">Auto</option>
                    <option value="strict">Strict</option>
                  </select>
                </label>
                <button disabled={busy}>Change unlock mode</button>
              </form>
            </details>
          )}
        </>
      )}
      {kit && (
        <div className="recovery-kit">
          <h3>Save your recovery kit</h3>
          <p>
            This is your way back into the vault if you forget the passphrase. Save it somewhere
            private, away from this server.
          </p>
          <button
            type="button"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([kit], { type: 'text/plain' }));
              const link = document.createElement('a');
              link.href = url;
              link.download = 'sazuz-recovery-kit.txt';
              link.click();
              URL.revokeObjectURL(url);
              setDownloaded(true);
            }}
          >
            Download recovery kit
          </button>
          <form
            className="setup-form"
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              void run(async () => {
                await api('vault/confirm-recovery', okSchema, {
                  characters: values.get('characters'),
                });
                setKit(null);
              });
            }}
          >
            <label className="setup-field">
              Last four characters of the recovery key
              <input name="characters" maxLength={4} minLength={4} required autoComplete="off" />
            </label>
            <button disabled={!downloaded || busy}>Confirm recovery kit saved</button>
          </form>
        </div>
      )}
      {error && (
        <p role="alert" className="setup-error">
          {error}
        </p>
      )}
    </section>
  );
}

export function SecretControls({
  secrets,
  onChange,
}: {
  secrets: SecretItem[];
  onChange: (items: SecretItem[]) => void;
}) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <details className="setup-details credential-details">
      <summary>Vault credentials ({secrets.length})</summary>
      <p>
        Add an API key or token here, then choose it in the form. Saved values are never displayed
        again.
      </p>
      <ul className="credential-list">
        {secrets.map((secret) => (
          <li key={secret.id}>
            <strong>{secret.name}</strong>
            <code>{secret.maskedValue}</code>
          </li>
        ))}
      </ul>
      <form
        className="setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = new FormData(form);
          setBusy(true);
          setMessage('');
          void (async () => {
            await api('vault/secrets', z.object({ id: z.string(), reference: z.string() }), {
              name: values.get('name'),
              value: values.get('value'),
            });
            form.reset();
            onChange(await api('vault/secrets', secretListSchema));
            setMessage('Credential encrypted and saved.');
          })()
            .catch((cause: unknown) =>
              setMessage(cause instanceof Error ? cause.message : 'Could not save credential.'),
            )
            .finally(() => setBusy(false));
        }}
      >
        <label className="setup-field">
          Credential name
          <input name="name" maxLength={128} required autoComplete="off" />
        </label>
        <label className="setup-field">
          Secret value
          <input name="value" type="password" required autoComplete="off" />
        </label>
        <button disabled={busy}>Save credential in vault</button>
        {message && <p role="status">{message}</p>}
      </form>
    </details>
  );
}
