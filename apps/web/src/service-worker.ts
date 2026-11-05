/// <reference lib="webworker" />
import { z } from 'zod';

z.config({ jitless: true });
const worker = globalThis as unknown as ServiceWorkerGlobalScope;
const cacheName = 'sazuz-public-v1';
const publicPaths = ['/offline.html', '/pwa-192.png', '/pwa-512.png'];
worker.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName);
      for (const path of publicPaths) {
        const response = await fetch(path, { credentials: 'omit', cache: 'reload' });
        if (!response.ok) throw new Error('Public offline assets are unavailable.');
        await cache.put(path, response);
      }
      await worker.skipWaiting();
    })(),
  );
});
worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('sazuz-public-') && key !== cacheName) await caches.delete(key);
      await worker.clients.claim();
    })(),
  );
});
worker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== worker.location.origin) return;
  if (!url.search && publicPaths.includes(url.pathname)) {
    event.respondWith((async () => (await caches.match(url.pathname)) ?? fetch(event.request))());
  } else if (event.request.mode === 'navigate') {
    // Authenticated pages only ever come from the network. The fallback contains no workspace data.
    event.respondWith(
      fetch(event.request).catch(
        async () => (await caches.match('/offline.html')) ?? Response.error(),
      ),
    );
  }
});
const payloadSchema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(['activity', 'digest']),
});
worker.addEventListener('push', (event) => {
  let raw: unknown;
  try {
    if (!event.data || event.data.text().length > 128) return;
    raw = event.data.json();
  } catch {
    console.warn('Ignored an invalid browser notification.');
    return;
  }
  const payload = payloadSchema.safeParse(raw);
  if (!payload.success) return;
  event.waitUntil(
    worker.registration.showNotification('Sazuz', {
      body:
        payload.data.kind === 'digest'
          ? 'Your digest is ready. Open Sazuz to read it.'
          : 'You have new activity. Open Sazuz to view it.',
      icon: '/pwa-192.png',
      badge: '/pwa-192.png',
      tag: 'sazuz-activity',
      data: { path: '/notifications' },
    }),
  );
});
worker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const url = new URL('/notifications', worker.location.origin).href;
      const windows = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === worker.location.origin) {
          await client.navigate(url);
          await client.focus();
          return;
        }
      }
      await worker.clients.openWindow(url);
    })(),
  );
});
