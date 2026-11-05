import { createECDH, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { z } from 'zod';
import { settingsDocumentSchema } from '@sazuz/config/settings';
import { auditBundleSchema } from '@sazuz/core/audit';
import { pushStatusSchema } from '@sazuz/core/push';
import { ownerApi, voiceWorkspace } from './phase-eleven-helpers';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream'] } });

test.describe('Phase 11 PWA', () => {
  test.use({ serviceWorkers: 'allow' });
  test('production manifest, worker activation and public-only offline fallback', async ({
    page,
    context,
  }, info) => {
    await ownerApi(context, info);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/manifest.webmanifest',
    );
    const manifest = await context.request.get('/manifest.webmanifest');
    expect(manifest.ok()).toBe(true);
    expect(await manifest.json()).toMatchObject({
      name: 'Sazuz',
      start_url: '/chat',
      display: 'standalone',
      scope: '/',
    });
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state))
      .toBe('activated');
    const cachePaths = () =>
      page.evaluate(async () => {
        const names = await caches.keys();
        return (
          await Promise.all(
            names.map(async (name) =>
              (await (await caches.open(name)).keys()).map((entry) => new URL(entry.url).pathname),
            ),
          )
        )
          .flat()
          .sort();
      });
    expect(await cachePaths()).toEqual(['/offline.html', '/pwa-192.png', '/pwa-512.png']);
    await page.evaluate(async () => {
      await fetch('/api/settings');
      await fetch('/api/vault/secrets');
    });
    expect(await cachePaths()).toEqual(['/offline.html', '/pwa-192.png', '/pwa-512.png']);
    await context.setOffline(true);
    try {
      await page.goto('/chat');
      await expect(page.getByRole('heading', { name: 'Sazuz is offline' })).toBeVisible();
      expect(await page.locator('body').innerText()).not.toMatch(
        /browser-owner|credential|recovery key/i,
      );
      expect(
        await page.evaluate(() =>
          fetch('/api/settings').then(
            () => false,
            () => true,
          ),
        ),
      ).toBe(true);
      await page.screenshot({ path: info.outputPath('phase11-offline.png'), fullPage: true });
    } finally {
      await context.setOffline(false);
    }
    await info.attach('phase11-pwa-evidence', {
      contentType: 'application/json',
      body: JSON.stringify({
        actualWorker: true,
        offlineFallback: true,
        cachedPaths: await cachePaths(),
        privateResponsesCached: false,
      }),
    });
  });
});

test.describe('Phase 11 voice browser capture', () => {
  test('record, review and edit before Send, then play an owned saved answer', async ({
    page,
    context,
  }, info) => {
    await context.grantPermissions(['microphone']);
    const fixture = await voiceWorkspace(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/chat');
    await page.getByRole('button', { name: 'Record voice', exact: true }).click();
    await expect(page.getByText('Microphone on. Press Stop to transcribe.')).toBeVisible();
    // Capture a real MediaRecorder chunk from Chromium's synthetic microphone.
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
      'Please review my local voice note.',
    );
    expect(fixture.recordings).toHaveLength(1);
    expect(fixture.recordings[0]).toBeGreaterThan(0);
    expect(fixture.chats).toHaveLength(0);
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Please save my edited local voice note.');
    await page.screenshot({ path: info.outputPath('phase11-reviewed-voice.png'), fullPage: true });
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByText('Your reviewed note is ready.', { exact: true })).toBeVisible();
    expect(fixture.chats).toHaveLength(1);
    expect(fixture.chats[0]).toMatchObject({
      content: 'Please save my edited local voice note.',
      voiceReceiptId: fixture.receiptId,
    });
    await page.getByRole('button', { name: 'Read aloud', exact: true }).click();
    await expect(page.getByLabel('Spoken answer')).toHaveAttribute('src', /^blob:/);
    expect(fixture.playback).toHaveLength(1);
    await page.getByLabel('Spoken answer').evaluate((element: HTMLAudioElement) => element.play());
    await expect
      .poll(() =>
        page
          .getByLabel('Spoken answer')
          .evaluate((element: HTMLAudioElement) => element.readyState),
      )
      .toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
  });
  test('microphone denial stays visible without starting transcription or chat', async ({
    page,
  }) => {
    const fixture = await voiceWorkspace(page);
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        value: () =>
          Promise.reject(new DOMException('Microphone permission was denied.', 'NotAllowedError')),
      });
    });
    await page.goto('/chat');
    await page.getByRole('button', { name: 'Record voice', exact: true }).click();
    await expect(
      page.getByText('Microphone permission was denied.', { exact: true }),
    ).toBeVisible();
    expect(fixture.recordings).toHaveLength(0);
    expect(fixture.chats).toHaveLength(0);
    await expect(page.getByRole('button', { name: 'Record voice', exact: true })).toBeEnabled();
  });
});

test('Phase 11 production: push opt-in, denied permission, enrollment and revocation', async ({
  page,
  context,
}, info) => {
  const api = await ownerApi(context, info);
  const deviceName = `Browser verification ${randomBytes(4).toString('hex')}`;
  const before = await api('GET', 'settings', settingsDocumentSchema);
  await api('PUT', 'settings/channels', z.unknown(), {
    expectedVersion: before.channels.version,
    value: { ...before.channels.value, webPush: false },
  });
  const curve = createECDH('prime256v1');
  curve.generateKeys();
  const subscription = {
    endpoint: `https://fcm.googleapis.com/fcm/send/phase11-${randomBytes(12).toString('hex')}`,
    expirationTime: null,
    keys: {
      p256dh: curve.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
  await page.addInitScript((data) => {
    const state = { permission: 'denied' as NotificationPermission, subscriptions: 0 };
    Object.defineProperty(window, '__phase11Push', { value: state });
    Object.defineProperty(Notification, 'requestPermission', {
      value: () => Promise.resolve(state.permission),
    });
    Object.defineProperty(navigator.serviceWorker, 'ready', {
      value: Promise.resolve({
        pushManager: {
          getSubscription: () => Promise.resolve(null),
          subscribe: () => {
            state.subscriptions++;
            return Promise.resolve({ toJSON: () => data });
          },
        },
      }),
    });
  }, subscription);
  await page.goto('/settings?section=channels');
  const enroll = page.getByRole('button', { name: 'Enable on this browser', exact: true });
  await expect(enroll).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Web Push', exact: true }).check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(enroll).toBeEnabled();
  await enroll.click();
  await expect(page.getByText(/Notification permission was not granted/)).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __phase11Push: { subscriptions: number } }).__phase11Push
          .subscriptions,
    ),
  ).toBe(0);
  await page.evaluate(() => {
    (
      window as unknown as { __phase11Push: { permission: NotificationPermission } }
    ).__phase11Push.permission = 'granted';
  });
  await page.getByLabel('Device name', { exact: true }).fill(deviceName);
  await enroll.click();
  await expect(page.getByText(/Browser enrolled\. Generic notices/)).toBeVisible();
  const status = await api('GET', 'channels/push', pushStatusSchema);
  expect(status.devices.some((device) => device.name === deviceName && !device.revokedAt)).toBe(
    true,
  );
  expect(JSON.stringify(status)).not.toContain(subscription.endpoint);
  expect(JSON.stringify(status)).not.toContain(subscription.keys.auth);
  await page.getByRole('button', { name: `Revoke ${deviceName}`, exact: true }).click();
  await expect(page.getByText(`${deviceName} · Revoked`)).toBeVisible();
  const current = await api('GET', 'settings', settingsDocumentSchema);
  await api('PUT', 'settings/channels', z.unknown(), {
    expectedVersion: current.channels.version,
    value: before.channels.value,
  });
  await page.screenshot({ path: info.outputPath('phase11-push.png'), fullPage: true });
});

test('Phase 11 production: enroll, sign in and remove a WebAuthn passkey; export audit', async ({
  page,
  context,
}, info) => {
  test.setTimeout(90000);
  const api = await ownerApi(context, info);
  const settings = await api('GET', 'settings', settingsDocumentSchema);
  // WebAuthn requires a domain RP ID. Exercise the configured localhost origin,
  // preserving the same exact-origin checks used by a remote HTTPS deployment.
  const site = new URL(z.string().parse(info.project.use.baseURL));
  site.hostname = 'localhost';
  await api('PUT', 'settings/general', z.unknown(), {
    expectedVersion: settings.general.version,
    value: { ...settings.general.value, baseUrl: site.origin },
  });
  const localApi = await ownerApi(context, info, site.origin);
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const authenticator = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  try {
    await page.goto(`${site.origin}/settings`);
    await page.getByText(/^Passkeys \(/).click();
    await page.getByLabel('Passkey name', { exact: true }).fill('Virtual browser authenticator');
    await page.getByRole('button', { name: 'Add a passkey', exact: true }).click();
    await expect(
      page.getByText('Passkey added. Keep your password and recovery codes available.'),
    ).toBeVisible();
    await localApi('POST', 'auth/sign-out', z.unknown(), {});
    await page.goto(`${site.origin}/login`);
    await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
    await expect(page).toHaveURL(/\/settings/);
    await page.getByText(/^Passkeys \(/).click();
    await page
      .getByRole('button', { name: 'Remove Virtual browser authenticator', exact: true })
      .click();
    await expect(page.getByText('Passkey removed.', { exact: true })).toBeVisible();
    await page.goto(`${site.origin}/audit`);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Verify and export', exact: true }).click();
    const download = await downloadPromise;
    const bundle = auditBundleSchema.parse(
      JSON.parse(await readFile(await download.path(), 'utf8')),
    );
    expect(bundle.head.sequence).toBeGreaterThan(0);
    expect(bundle.pages.at(-1)?.complete).toBe(true);
    await expect(page.getByText(/Exported \d+ verified entries/)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('phase11-audit-mobile.png'), fullPage: true });
  } finally {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', authenticator);
    await cdp.detach();
    const current = await api('GET', 'settings', settingsDocumentSchema);
    await api('PUT', 'settings/general', z.unknown(), {
      expectedVersion: current.general.version,
      value: settings.general.value,
    });
  }
});

test('Phase 11 production: create and download a real encrypted database backup', async ({
  page,
  context,
}, info) => {
  test.setTimeout(180000);
  await ownerApi(context, info);
  let loadSettings!: () => void;
  const settingsReady = new Promise<void>((resolve) => {
    loadSettings = resolve;
  });
  await page.route('**/api/settings', async (route) => {
    await settingsReady;
    await route.continue();
  });
  try {
    await page.goto('/settings?section=backups');
    await expect(
      page.getByRole('button', { name: 'Create encrypted backup', exact: true }),
    ).toBeDisabled();
  } finally {
    loadSettings();
  }
  await page.getByRole('button', { name: 'Create encrypted backup', exact: true }).click();
  await expect(
    page.getByText('Encrypted backup is ready to download.', { exact: true }),
  ).toBeVisible({ timeout: 120000 });
  await expect(page.getByText('Loading settings…', { exact: true })).toBeHidden();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download encrypted backup', exact: true }).first().click();
  const download = await downloadPromise,
    bytes = await readFile(await download.path());
  expect(bytes.length).toBeGreaterThan(1000);
  expect(bytes.includes(Buffer.from('Browser-admin-password-7814'))).toBe(false);
  expect(bytes.includes(Buffer.from('sk-browser-canary'))).toBe(false);
  await page.screenshot({ path: info.outputPath('phase11-backups.png'), fullPage: true });
  await info.attach('phase11-backup-evidence', {
    contentType: 'application/json',
    body: JSON.stringify({
      realPostgresDump: true,
      encryptedBytes: bytes.length,
      downloaded: true,
    }),
  });
});
