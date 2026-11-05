import { z } from 'zod';
import type { CDPSession, Page } from 'playwright';
import type { WebSocket } from 'ws';
import { browserFrameSchema, browserHumanInputSchema, BrowserError } from '@sazuz/core/browser';
import { browserSocketText } from '@sazuz/browser/protocol';
import type { BrowserEngine } from './engine.js';
import { currentPage } from './session.js';

const frameSchema = z.object({
  data: browserFrameSchema.shape.data,
  sessionId: z.number().int().positive(),
});

/** One viewer per session; all queues and frames are bounded, and disconnect never hands back. */
export function streamBrowser(
  engine: BrowserEngine,
  id: string,
  socket: WebSocket,
  report: () => void,
) {
  let closed = false;
  let cast: { client: CDPSession; page: Page } | undefined;
  let pendingFrame: { client: CDPSession; data: string } | undefined;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let flushing = false;
  let syncing = false;
  let lastFrame = 0;
  let queued = 0;
  let windowStart = Date.now();
  let inputs = 0;
  let work = Promise.resolve();
  const detach = async () => {
    const previous = cast;
    cast = undefined;
    pendingFrame = undefined;
    clearTimeout(frameTimer);
    frameTimer = undefined;
    if (previous) {
      try {
        await previous.client.send('Page.stopScreencast');
      } finally {
        await previous.client.detach();
      }
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    socket.close(1008, 'Browser view ended.');
    void detach().catch(report);
  };
  const scheduleFrame = () => {
    if (closed || flushing || frameTimer || !pendingFrame) return;
    frameTimer = setTimeout(
      () => {
        frameTimer = undefined;
        flushing = true;
        void (async () => {
          await engine.valid(id, true);
          const frame = pendingFrame;
          if (!frame || closed || cast?.client !== frame.client || socket.readyState !== 1) return;
          lastFrame = Date.now();
          if (socket.bufferedAmount > 2000000) return;
          pendingFrame = undefined;
          socket.send(
            JSON.stringify(
              browserFrameSchema.parse({
                type: 'frame',
                data: frame.data,
                width: 1280,
                height: 800,
              }),
            ),
            (error) => {
              if (error) close();
            },
          );
        })()
          .catch(close)
          .finally(() => {
            flushing = false;
            scheduleFrame();
          });
      },
      Math.max(0, 200 - (Date.now() - lastFrame)),
    );
    frameTimer.unref();
  };
  const sync = async () => {
    const session = await engine.valid(id, true);
    if (closed) return;
    const page = currentPage(session);
    if (cast?.page === page) return;
    await detach();
    const client = await session.context.newCDPSession(page);
    if (closed) {
      await client.detach();
      return;
    }
    cast = { client, page };
    lastFrame = 0;
    client.on('Page.screencastFrame', (input: unknown) => {
      if (closed || cast?.client !== client) return;
      try {
        const frame = frameSchema.parse(input);
        // Keep one latest frame so throttling cannot discard a static page's final paint.
        pendingFrame = { client, data: frame.data };
        void client.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {
          if (cast?.client === client) close();
        });
        scheduleFrame();
      } catch {
        if (cast?.client === client) close();
      }
    });
    await client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: session.launch.screencastQuality,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
  };
  const timer = setInterval(() => {
    if (syncing || closed) return;
    syncing = true;
    void sync()
      .catch(close)
      .finally(() => {
        syncing = false;
      });
  }, 500);
  timer.unref();
  socket.on('message', (data, binary) => {
    try {
      if (Date.now() - windowStart >= 1000) {
        windowStart = Date.now();
        inputs = 0;
      }
      if (closed || binary || ++inputs > 60 || queued >= 8)
        throw new BrowserError('BROWSER_DENIED');
      const message = browserHumanInputSchema.parse(JSON.parse(browserSocketText(data)));
      queued++;
      work = work
        .then(async () => {
          if (!closed) await engine.input(id, message);
        })
        .catch(close)
        .finally(() => {
          queued--;
        });
    } catch {
      close();
    }
  });
  socket.on('close', close);
  socket.on('error', close);
  syncing = true;
  void sync()
    .catch(close)
    .finally(() => {
      syncing = false;
    });
  return close;
}
