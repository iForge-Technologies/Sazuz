import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAINTENANCE_LOCK } from '@sazuz/db';
import { registerBackups } from '../../apps/server/src/phase-eleven-backups.js';
import { phaseFourFixture } from './phase-four-fixture.js';

describe('Phase 11 maintenance admission after a disconnected HTTP handler', () => {
  let fixture: Awaited<ReturnType<typeof phaseFourFixture>>;
  let origin: string;
  let entered = () => {};
  let effect: Promise<void> = Promise.resolve();
  let finished = () => {};
  let admissionClosed = () => {};
  let uploadHandlers = 0;
  beforeAll(async () => {
    fixture = await phaseFourFixture((app, runtime) => {
      app.addHook('onRequest', (request, reply, done) => {
        if (request.url === '/activity-fixture/upload')
          reply.raw.once('close', () => admissionClosed());
        done();
      });
      app.post('/activity-fixture/upload', () => {
        uploadHandlers += 1;
        return { ok: true };
      });
      for (const hijack of [true, false])
        app.post(`/activity-fixture/${hijack ? 'stream' : 'ordinary'}`, async (_request, reply) => {
          if (hijack) {
            reply.hijack();
            reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
            reply.raw.write(': connected\n\n');
          }
          entered();
          // The client can disappear while an admitted asynchronous action is
          // still running. Its lease must remain until the handler settles.
          await effect;
          finished();
          if (hijack) {
            if (!reply.raw.destroyed) reply.raw.end();
            return;
          }
          return { ok: true };
        });
      app.post('/activity-fixture/early-stream', (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
        reply.raw.write(': connected\n\n');
        entered();
        // A transport can own a response after the route handler returns.
        // Ending this handler must not admit a snapshot while it remains open.
      });
      registerBackups(app, runtime, { background: false });
    });
    origin = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => fixture?.close());
  it('releases a lease acquired after an unfinished upload has already disconnected', async () => {
    const lease = await fixture.db.coordination.connect();
    const connection = await fixture.db.coordination.connect();
    let enter!: () => void, allow!: () => void, close!: () => void;
    const acquiring = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const admitted = new Promise<void>((resolve) => {
      allow = resolve;
    });
    const disconnected = new Promise<void>((resolve) => {
      close = resolve;
    });
    admissionClosed = close;
    const query = vi.spyOn(lease, 'query');
    // This fixture intercepts the promise overload, not Pool's callback overload.
    const coordination: { connect: () => Promise<typeof lease> } = fixture.db.coordination;
    const connect = vi.spyOn(coordination, 'connect').mockImplementationOnce(async () => {
      enter();
      await admitted;
      return lease;
    });
    const request = httpRequest(`${origin}/activity-fixture/upload`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost:7777',
        'content-type': 'application/json',
        'content-length': '2',
      },
    });
    request.on('error', (error) => {
      if (!request.destroyed) throw error;
    });
    try {
      // Send headers only: the client leaves while database admission is pending,
      // before Fastify begins reading the promised body or invokes the handler.
      request.flushHeaders();
      await acquiring;
      request.destroy();
      await disconnected;
      allow();
      await expect
        .poll(() =>
          query.mock.calls.some(
            ([sql]) => typeof sql === 'string' && sql.includes('FROM operation_gate'),
          ),
        )
        .toBe(true);
      await expect
        .poll(
          async () => {
            const result = await connection.query<{ locked: boolean }>(
              'SELECT pg_try_advisory_lock($1) AS locked',
              [MAINTENANCE_LOCK],
            );
            if (!result.rows[0]?.locked) return false;
            await connection.query('SELECT pg_advisory_unlock($1)', [MAINTENANCE_LOCK]);
            return true;
          },
          { timeout: 2000, interval: 25 },
        )
        .toBe(true);
      expect(uploadHandlers).toBe(0);
    } finally {
      request.destroy();
      allow();
      connect.mockRestore();
      query.mockRestore();
      connection.release();
    }
  });
  it.each(['stream', 'ordinary'])(
    'keeps a disconnected %s action admitted, then releases it for backups',
    async (kind) => {
      let enter!: () => void, complete!: () => void, finish!: () => void;
      const started = new Promise<void>((resolve) => {
        enter = resolve;
      });
      effect = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const settled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      entered = enter;
      finished = finish;
      const controller = new AbortController();
      const request = fetch(`${origin}/activity-fixture/${kind}`, {
        method: 'POST',
        headers: { origin: 'http://localhost:7777', 'content-type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      }).then(
        async (response) => {
          try {
            await response.text();
          } catch (error) {
            if (!controller.signal.aborted) throw error;
          }
        },
        (error: unknown) => {
          if (!controller.signal.aborted) throw error;
        },
      );
      const connection = await fixture.db.coordination.connect();
      const available = async () => {
        const result = await connection.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS locked',
          [MAINTENANCE_LOCK],
        );
        if (result.rows[0]?.locked) {
          await connection.query('SELECT pg_advisory_unlock($1)', [MAINTENANCE_LOCK]);
          return true;
        }
        return false;
      };
      try {
        await Promise.race([
          started,
          request.then(() => {
            throw new Error('The fixture request ended before its handler started.');
          }),
        ]);
        controller.abort();
        await request;
        expect(await available()).toBe(false);
        complete();
        await settled;
        await expect.poll(available, { timeout: 2000, interval: 25 }).toBe(true);
      } finally {
        complete();
        connection.release();
      }
    },
  );
  it('retains an early-returned raw response until the client closes it', async () => {
    let enter!: () => void;
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    entered = enter;
    const controller = new AbortController();
    const connection = await fixture.db.coordination.connect();
    const available = async () => {
      const result = await connection.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [MAINTENANCE_LOCK],
      );
      if (!result.rows[0]?.locked) return false;
      await connection.query('SELECT pg_advisory_unlock($1)', [MAINTENANCE_LOCK]);
      return true;
    };
    try {
      const response = await fetch(`${origin}/activity-fixture/early-stream`, {
        method: 'POST',
        headers: { origin: 'http://localhost:7777', 'content-type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      await started;
      expect(await available()).toBe(false);
      controller.abort();
      await expect(response.text()).rejects.toThrow();
      await expect.poll(available, { timeout: 2000, interval: 25 }).toBe(true);
    } finally {
      controller.abort();
      connection.release();
    }
  });
});
