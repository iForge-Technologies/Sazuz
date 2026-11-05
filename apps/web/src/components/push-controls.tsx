'use client';
import { useEffect, useState } from 'react';
import { pushDeviceSchema, pushStatusSchema } from '@sazuz/core/push';
import type { z } from 'zod';
import { api } from '../lib/api';

export function PushControls() {
  const [status, setStatus] = useState<z.infer<typeof pushStatusSchema> | null>(null),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [name, setName] = useState('This browser');
  const refresh = async () => setStatus(await api('channels/push', pushStatusSchema));
  useEffect(() => {
    void refresh().catch(() => setNotice('Browser notification settings could not load.'));
  }, []);
  async function enroll() {
    setBusy(true);
    setNotice('');
    try {
      if (
        !('serviceWorker' in navigator) ||
        !('PushManager' in window) ||
        !('Notification' in window) ||
        !window.isSecureContext
      )
        throw new Error(
          'This browser needs HTTPS and Web Push support. On iOS, first add Sazuz to your Home Screen.',
        );
      const permission = await Notification.requestPermission();
      if (permission !== 'granted')
        throw new Error(
          'Notification permission was not granted. You can change it in browser settings.',
        );
      const registration = await navigator.serviceWorker.ready;
      const current = await api('channels/push', pushStatusSchema);
      if (!current.enabled)
        throw new Error('Enable Web Push below and save Channels settings first.');
      const key = Uint8Array.from(
        atob(current.publicKey.replaceAll('-', '+').replaceAll('_', '/')),
        (letter) => letter.charCodeAt(0),
      );
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        }));
      await api('channels/push', pushDeviceSchema, {
        name,
        subscription: subscription.toJSON(),
        consent: true,
      });
      await refresh();
      setNotice(
        'Browser enrolled. Generic notices follow your channel, quiet-hour and interruption settings.',
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Browser enrollment could not finish.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-panel configuration-section" aria-label="Browser notifications">
      <h2>Browser notifications</h2>
      <p>
        Enable Web Push below, save, then enroll this browser. Notices contain no message text. Your
        browser push service receives subscription data and the owner email as the VAPID contact.
      </p>
      <label className="setup-field">
        Device name
        <input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <button
        type="button"
        className="secondary"
        disabled={!status?.enabled || busy || !name.trim()}
        onClick={() => {
          void enroll();
        }}
      >
        Enable on this browser
      </button>
      {status?.devices.map((device) => (
        <div className="account-device-row" key={device.id}>
          <p>
            <strong>{device.name}</strong> · {device.revokedAt ? 'Revoked' : 'Enrolled'}
          </p>
          {!device.revokedAt && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void api(`channels/push/${device.id}`, pushDeviceSchema, {}, 'DELETE')
                  .then(refresh)
                  .catch(() => setNotice('Device revocation could not finish.'))
                  .finally(() => setBusy(false));
              }}
            >
              Revoke {device.name}
            </button>
          )}
        </div>
      ))}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
