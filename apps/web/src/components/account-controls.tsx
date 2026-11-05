'use client';
import { useState } from 'react';
import { z } from 'zod';
import { api, okSchema } from '../lib/api';
import { PasskeySignIn } from './passkeys';

export function LoginForm({
  create = false,
  onSignedIn,
}: {
  create?: boolean;
  onSignedIn: () => Promise<void> | void;
}) {
  const [challenge, setChallenge] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="setup-form account-form"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const values = new FormData(form);
        setBusy(true);
        setError('');
        void (async () => {
          if (challenge) {
            await api('auth/two-factor/verify-totp', okSchema, { code: values.get('code') });
            await onSignedIn();
            return;
          }
          const credentials = { email: values.get('email'), password: values.get('password') };
          if (create)
            await api('setup/admin', okSchema, { name: values.get('name'), ...credentials });
          const result = await api(
            'auth/sign-in/email',
            z.object({ ok: z.boolean(), twoFactorRedirect: z.boolean().optional() }),
            credentials,
          );
          form.reset();
          if (result.twoFactorRedirect) setChallenge(true);
          else await onSignedIn();
        })()
          .catch((cause: unknown) =>
            setError(cause instanceof Error ? cause.message : 'Sign-in failed.'),
          )
          .finally(() => setBusy(false));
      }}
    >
      {challenge ? (
        <label className="setup-field">
          Authenticator code
          <input
            name="code"
            className="auth-code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            autoComplete="one-time-code"
            required
            autoFocus
          />
        </label>
      ) : (
        <>
          {create && (
            <label className="setup-field">
              Your name
              <input name="name" autoComplete="name" maxLength={120} required />
            </label>
          )}
          <label className="setup-field">
            Email
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label className="setup-field">
            Password
            <input
              name="password"
              type="password"
              minLength={create ? 12 : 1}
              maxLength={128}
              autoComplete={create ? 'new-password' : 'current-password'}
              required
            />
            {create && (
              <small>Use at least 12 characters, including a letter and a number or symbol.</small>
            )}
          </label>
        </>
      )}
      {error && (
        <p role="alert" className="setup-error">
          {error}
        </p>
      )}
      <button disabled={busy}>
        {busy
          ? 'Working…'
          : challenge
            ? 'Verify and sign in'
            : create
              ? 'Create admin account'
              : 'Sign in'}
      </button>
      {!create && !challenge && (
        <div className="passkey-alternative">
          <span className="auth-divider" aria-hidden="true">
            or
          </span>
          <PasskeySignIn onSignedIn={onSignedIn} />
        </div>
      )}
    </form>
  );
}

export function TwoFactorControls() {
  const [provision, setProvision] = useState<{ totpURI: string; backupCodes: string[] } | null>(
    null,
  );
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <details className="setup-details account-security-details">
      <summary>Two-factor authentication</summary>
      <p>
        Add Sazuz to your authenticator, then verify a live code. Keep the backup codes offline.
      </p>
      <form
        className="setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = new FormData(form);
          setBusy(true);
          setMessage('');
          void (async () => {
            if (provision) {
              await api('auth/two-factor/verify-totp', okSchema, { code: values.get('code') });
              setProvision(null);
              setMessage('Two-factor authentication is enabled and verified.');
            } else {
              const result = await api(
                'auth/two-factor/enable',
                z.object({ totpURI: z.string(), backupCodes: z.array(z.string()) }),
                { password: values.get('password') },
              );
              setProvision(result);
            }
            form.reset();
          })()
            .catch((cause: unknown) =>
              setMessage(
                cause instanceof Error
                  ? cause.message
                  : 'Could not update two-factor authentication.',
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        {provision ? (
          <>
            <label className="setup-field">
              Authenticator setup key
              <input value={new URL(provision.totpURI).searchParams.get('secret') ?? ''} readOnly />
            </label>
            <details>
              <summary>Backup codes (save offline)</summary>
              <pre>{provision.backupCodes.join('\n')}</pre>
            </details>
            <label className="setup-field">
              Verification code
              <input
                name="code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                required
                autoComplete="one-time-code"
              />
            </label>
          </>
        ) : (
          <label className="setup-field">
            Current password
            <input name="password" type="password" required autoComplete="current-password" />
          </label>
        )}
        <button disabled={busy}>
          {busy
            ? 'Working…'
            : provision
              ? 'Verify two-factor authentication'
              : 'Set up authenticator'}
        </button>
        {message && <p role="status">{message}</p>}
      </form>
    </details>
  );
}
