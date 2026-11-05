import { useState } from 'react';
import { z } from 'zod';
import type { SettingsDocument } from '@sazuz/config/settings';
import { api } from '../lib/api';
import { workspaceError } from '../lib/use-workspace';

const startSchema = z.strictObject({
  authorizationUrl: z.url().refine((value) => {
    const url = new URL(value);
    return (
      ['https://accounts.google.com', 'https://login.microsoftonline.com'].includes(url.origin) &&
      !url.username &&
      !url.password
    );
  }),
  expiresAt: z.iso.datetime(),
});

export function GoogleConnections({ settings }: { settings: SettingsDocument }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const accounts = settings.connectors.value.accounts.filter(
    (account) =>
      account.provider === 'gmail' ||
      account.provider?.startsWith('google-') ||
      account.provider === 'microsoft-graph',
  );
  async function connect(id: string, provider: 'google' | 'microsoft') {
    setBusy(true);
    setError('');
    try {
      const result = await api(`connectors/${id}/oauth/${provider}/start`, startSchema, {
        version: settings.connectors.version,
      });
      window.location.assign(result.authorizationUrl);
    } catch (cause) {
      setError(workspaceError(cause));
      setBusy(false);
    }
  }
  return (
    <section
      className="google-connections configuration-section"
      aria-label="Account authorization"
    >
      <h2>Connect Google and Microsoft accounts</h2>
      <p>
        Save the account with its OAuth client ID, vault client-secret reference and redirect URL,
        then authorize its selected scopes. Agent account grants are managed in Agents.
      </p>
      <dl className="connection-callbacks">
        <dt>Google callback</dt>
        <dd>
          <code>{settings.general.value.baseUrl}/oauth/google/callback</code>
        </dd>
        <dt>Microsoft callback</dt>
        <dd>
          <code>{settings.general.value.baseUrl}/oauth/microsoft/callback</code>
        </dd>
      </dl>
      {!accounts.length && <p>Add a Google or Microsoft account below to connect it.</p>}
      {accounts.map((account) => (
        <div className="connection-row" key={account.id}>
          <div>
            <strong>{account.name}</strong>
            <p>{account.secretRef ? 'Credential saved in the vault' : 'Authorization needed'}</p>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={
              busy ||
              !account.options.oauthClientId ||
              !account.options.oauthClientSecretRef ||
              !account.options.oauthRedirectUri
            }
            onClick={() => {
              void connect(
                account.id,
                account.provider === 'microsoft-graph' ? 'microsoft' : 'google',
              );
            }}
          >
            {account.secretRef ? 'Reconnect' : 'Connect'}{' '}
            {account.provider === 'microsoft-graph' ? 'Microsoft' : 'Google'} account
          </button>
        </div>
      ))}
      {error && (
        <p className="setup-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
