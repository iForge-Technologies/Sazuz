import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import { BrowserError } from '@sazuz/core/browser';
import {
  browserRpcSchema,
  browserRpcResultSchema,
  verifyBrowserMessage,
  browserLiveGrantSchema,
} from '@sazuz/browser/protocol';
import { createBrowserEngine, type BrowserEngineOptions } from './engine.js';
import { listenSettings } from '@sazuz/db';
import { freshSettings } from '@sazuz/config/settings';
import { streamBrowser } from './live.js';

export async function createBrowserApp(options: BrowserEngineOptions) {
  const app = Fastify({
    logger: false,
    bodyLimit: 131072,
    requestTimeout: 10000,
    connectionTimeout: 10000,
  });
  let settings = freshSettings();
  const listener = await listenSettings(options.database, (document) => {
    settings = document;
  });
  const engine = createBrowserEngine({ ...options, getSettings: () => settings });
  const nonces = new Map<string, number>();
  const viewers = new Map<string, () => void>();
  await app.register(websocket, { options: { maxPayload: 16384 } });
  function consumeNonce(nonce: string, expiry: number) {
    for (const [key, deadline] of nonces) if (deadline <= Date.now()) nonces.delete(key);
    if (nonces.has(nonce) || nonces.size >= 2000) throw new BrowserError('BROWSER_DENIED');
    nonces.set(nonce, expiry);
  }
  await engine.initialize();
  app.setErrorHandler((error, _request, reply) => {
    const code = error instanceof BrowserError ? error.code : 'BROWSER_UNAVAILABLE';
    void reply
      .code(
        code === 'BROWSER_DENIED'
          ? 403
          : code === 'BROWSER_CONFLICT' || code === 'BROWSER_UNCERTAIN'
            ? 409
            : 503,
      )
      .send({ error: { code } });
  });
  app.post('/internal/browser', async (request) => {
    const message = browserRpcSchema.parse(request.body);
    verifyBrowserMessage(
      options.key,
      'service',
      message,
      request.headers['x-sazuz-browser-signature'],
    );
    consumeNonce(message.nonce, message.expiresAt);
    return browserRpcResultSchema.parse(await engine.dispatch(message));
  });
  app.get(
    '/internal/browser-live/:id',
    {
      websocket: true,
      preValidation: async (request) => {
        z.strictObject({}).parse(request.query);
        const { id } = z
          .object({ id: browserLiveGrantSchema.shape.sessionId })
          .parse(request.params);
        const encoded = z.string().max(4096).parse(request.headers['x-sazuz-browser-grant']);
        const grant = browserLiveGrantSchema.parse(
          JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
        );
        verifyBrowserMessage(
          options.key,
          'live',
          grant,
          request.headers['x-sazuz-browser-signature'],
        );
        if (grant.sessionId !== id || viewers.has(id)) throw new BrowserError('BROWSER_DENIED');
        consumeNonce(grant.nonce, grant.expiresAt);
        await engine.valid(id, true);
      },
    },
    (socket, request) => {
      const { id } = z.object({ id: browserLiveGrantSchema.shape.sessionId }).parse(request.params);
      if (viewers.has(id)) {
        socket.close(1008, 'A browser view is already connected.');
        return;
      }
      viewers.set(
        id,
        streamBrowser(engine, id, socket, () =>
          options.database.logger.warn(
            { code: 'BROWSER_STREAM_CLOSED' },
            'A browser stream became unavailable during cleanup.',
          ),
        ),
      );
      socket.once('close', () => viewers.delete(id));
    },
  );
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void engine
      .sweep()
      .catch(() =>
        options.database.logger.warn(
          { code: 'BROWSER_CLEANUP_PENDING' },
          'Browser session cleanup will retry.',
        ),
      )
      .finally(() => {
        sweeping = false;
      });
  }, 1000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    for (const close of viewers.values()) close();
    await engine.stop();
    await listener.close();
  });
  return { app, engine };
}
