import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import {
  browserFrameSchema,
  browserHumanInputSchema,
  browserSessionId,
  BrowserError,
} from '@sazuz/core/browser';
import { publicBrowserSession } from '@sazuz/browser';
import {
  browserLiveGrantSchema,
  browserSocketText,
  signBrowserMessage,
} from '@sazuz/browser/protocol';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import type { BrowserControl } from './phase-five-control.js';
import { getControl } from '@sazuz/db';

export function registerBrowserLive(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  controls: BrowserControl,
) {
  app.get(
    '/live/browser/:id',
    {
      websocket: true,
      schema: { params: z.strictObject({ id: browserSessionId }), querystring: z.strictObject({}) },
      preValidation: async (request) => {
        runtime.verifyOrigin(request, false);
        const { user } = await runtime.admin(request);
        await controls.owned(user.id, request.params.id);
      },
    },
    (socket, request) => {
      const id = request.params.id;
      const grant = browserLiveGrantSchema.parse({
        sessionId: id,
        nonce: randomUUID(),
        expiresAt: Date.now() + 45000,
      });
      const target = new URL(`/internal/browser-live/${id}`, runtime.config.browserUrl);
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      const upstream = new WebSocket(target, {
        headers: {
          'x-sazuz-browser-grant': Buffer.from(JSON.stringify(grant)).toString('base64url'),
          'x-sazuz-browser-signature': signBrowserMessage(
            runtime.plumbing.operatorKey,
            'live',
            grant,
          ),
        },
        maxPayload: 2100000,
        handshakeTimeout: 5000,
        followRedirects: false,
      });
      let closed = false,
        checking = false,
        queued = 0,
        inputs = 0,
        windowStart = Date.now();
      let work = Promise.resolve();
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        socket.close(1008, 'Browser view ended.');
        upstream.terminate();
      };
      const authorize = async () => {
        const { user } = await runtime.admin(request);
        const row = await controls.owned(user.id, id);
        const inputAllowed =
          row.session.control === 'human' &&
          !row.run.claimKey &&
          ['paused', 'waiting_approval', 'budget_exceeded'].includes(row.run.status) &&
          !controls.transitions.has(id) &&
          !(await getControl(runtime.database)).paused;
        if (socket.readyState === 1 && !closed)
          socket.send(
            JSON.stringify({
              type: 'state',
              session: publicBrowserSession(row.session),
              inputAllowed,
            }),
          );
      };
      const timer = setInterval(() => {
        if (closed || checking) return;
        checking = true;
        void authorize()
          .catch(close)
          .finally(() => {
            checking = false;
          });
      }, 1000);
      timer.unref();
      upstream.on('message', (data, binary) => {
        try {
          if (closed || binary) throw new BrowserError('BROWSER_DENIED');
          const frame = browserFrameSchema.parse(JSON.parse(browserSocketText(data)));
          if (socket.readyState === 1 && socket.bufferedAmount <= 2000000)
            socket.send(JSON.stringify(frame), (error) => {
              if (error) close();
            });
        } catch {
          close();
        }
      });
      socket.on('message', (data, binary) => {
        try {
          if (Date.now() - windowStart >= 1000) {
            windowStart = Date.now();
            inputs = 0;
          }
          if (closed || binary || ++inputs > 60 || queued >= 8)
            throw new BrowserError('BROWSER_DENIED');
          const input = browserHumanInputSchema.parse(JSON.parse(browserSocketText(data)));
          queued++;
          work = work
            .then(async () => {
              const { user } = await runtime.admin(request);
              await controls.inputAllowed(user.id, id);
              if (closed || upstream.readyState !== 1 || controls.transitions.has(id))
                throw new BrowserError('BROWSER_DENIED');
              upstream.send(JSON.stringify(input));
            })
            .catch(close)
            .finally(() => {
              queued--;
            });
        } catch {
          close();
        }
      });
      upstream.on('open', () => {
        void authorize().catch(close);
      });
      for (const connection of [socket, upstream]) {
        connection.on('close', close);
        connection.on('error', close);
      }
    },
  );
}
