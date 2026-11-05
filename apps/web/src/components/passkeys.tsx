'use client';
import { useCallback, useEffect, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import {
  passkeyAuthenticateOptionsSchema,
  passkeyListSchema,
  passkeyRegisterOptionsSchema,
} from '@sazuz/core/audit';
import type { z } from 'zod';
import { api, okSchema } from '../lib/api';

export function PasskeySignIn({ onSignedIn }: { onSignedIn: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <div className="passkey-sign-in">
      <button
        className="secondary"
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setMessage('');
          void (async () => {
            const optionsJSON = await api(
              'passkeys/authenticate-options',
              passkeyAuthenticateOptionsSchema,
              {},
            );
            const response = await startAuthentication({
              optionsJSON: {
                challenge: optionsJSON.challenge,
                rpId: optionsJSON.rpId,
                timeout: optionsJSON.timeout,
                userVerification: optionsJSON.userVerification,
                allowCredentials: (optionsJSON.allowCredentials ?? []).map((item) => ({
                  id: item.id,
                  type: item.type,
                  transports: item.transports ?? [],
                })),
              },
            });
            await api('passkeys/authenticate', okSchema, { response });
            await onSignedIn();
          })()
            .catch(() =>
              setMessage(
                'Passkey sign-in did not complete. Use the hostname where you enrolled (localhost or your HTTPS domain), or sign in with your password. Browsers do not support passkeys on IP addresses.',
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Waiting for your authenticator…' : 'Use a passkey'}
      </button>
      {message && (
        <p className="setup-error" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}

export function PasskeyControls() {
  const [items, setItems] = useState<z.infer<typeof passkeyListSchema>>([]);
  const [name, setName] = useState('My passkey');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const refresh = useCallback(async () => setItems(await api('passkeys', passkeyListSchema)), []);
  useEffect(() => {
    void refresh().catch(() => setMessage('Sign in to manage your passkeys.'));
  }, [refresh]);
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    void action()
      .then(refresh)
      .catch(() =>
        setMessage(
          'Passkey changes did not complete. Sign in again and verify your identity on the authenticator.',
        ),
      )
      .finally(() => setBusy(false));
  };
  return (
    <details className="setup-details account-security-details">
      <summary>Passkeys ({items.length})</summary>
      <p>
        Use your device PIN, fingerprint or security key. Sign in again before adding or removing a
        passkey. Passkeys work on the site where you enroll.
      </p>
      <p>
        Use a hostname for passkeys: localhost on this machine, or your HTTPS domain. Set that
        address as Base Url in <a href="/settings?section=general">General</a>, then sign in at that
        address before enrolling. Browsers do not support passkeys on IP addresses.
      </p>
      <label className="setup-field">
        Passkey name
        <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
      </label>
      <button
        type="button"
        disabled={busy || !name.trim() || items.length >= 10}
        onClick={() =>
          run(async () => {
            const optionsJSON = await api(
              'passkeys/register-options',
              passkeyRegisterOptionsSchema,
              {},
            );
            const response = await startRegistration({
              optionsJSON: {
                challenge: optionsJSON.challenge,
                rp: optionsJSON.rp,
                user: optionsJSON.user,
                pubKeyCredParams: optionsJSON.pubKeyCredParams,
                timeout: optionsJSON.timeout,
                attestation: optionsJSON.attestation,
                excludeCredentials: optionsJSON.excludeCredentials.map((item) => ({
                  id: item.id,
                  type: item.type,
                  transports: item.transports ?? [],
                })),
                authenticatorSelection: {
                  residentKey: 'required',
                  requireResidentKey: true,
                  userVerification: 'required',
                },
                extensions: { credProps: true },
              },
            });
            await api('passkeys/register', okSchema, { response, name: name.trim() });
            setMessage('Passkey added. Keep your password and recovery codes available.');
          })
        }
      >
        {busy ? 'Working…' : 'Add a passkey'}
      </button>
      {items.map((item) => (
        <article className="history-entry account-device-row" key={item.id}>
          <div>
            <strong>{item.name ?? 'Passkey'}</strong>
            {' · '}
            {new Date(item.createdAt).toLocaleDateString()}
            {item.backedUp ? ' · synced' : ''}{' '}
          </div>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            aria-label={`Remove ${item.name ?? 'passkey'}`}
            onClick={() =>
              run(async () => {
                await api('passkeys/remove', okSchema, { id: item.id });
                setMessage('Passkey removed.');
              })
            }
          >
            Remove
          </button>
        </article>
      ))}
      {message && (
        <p role="status" className="setup-notice">
          {message}
        </p>
      )}
    </details>
  );
}
