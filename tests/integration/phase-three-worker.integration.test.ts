import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  channelState,
  costLedger,
  digests,
  getControl,
  missions,
  runs,
  setControl,
  telegramBindings,
  telegramPairingCodes,
  toolCalls,
  triggerEvents,
  triggers,
  workKey,
} from '@sazuz/db';
import { telegramPairSchema } from '@sazuz/core/missions';
import { createExecutionBroker } from '../../packages/runtime/src/broker.js';
import { insertTrigger } from '../../packages/runtime/src/automation.js';
import { deliverOnce } from '../../packages/runtime/src/notifications.js';
import { TelegramError } from '../../packages/channels/src/contracts.js';
import {
  fixtureBot,
  fixtureSecrets,
  fixtureSender,
  openWorkerFixture,
  workerPassphrase,
  type WorkerFixture,
} from './phase-three-worker-fixture.js';

describe('Assembled worker services with PostgreSQL, encrypted broker and official protocol fixtures', () => {
  let fixture: WorkerFixture;
  beforeAll(async () => {
    fixture = await openWorkerFixture();
  });
  afterEach(async () => {
    await fixture?.stop();
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it('consumes only matching encrypted capsules and suspends safely on locked or invalid broker responses', async () => {
    const work = await fixture.mission('Check the worker credential boundary.');
    const claimKey = randomUUID();
    await fixture.database.orm
      .update(runs)
      .set({ status: 'running', workerId: fixture.workerId, claimKey })
      .where(eq(runs.id, work.run.id));
    const scope = { scope: 'model' as const, executionId: 'run', runId: work.run.id, claimKey };
    const broker = createExecutionBroker(
      fixture.database,
      fixture.config,
      fixture.workerId,
      fixture.fetcher,
    );
    await broker.ready(scope, new AbortController().signal);
    expect(
      await broker.secret(fixture.references.provider, scope, (value) =>
        Promise.resolve(value === fixtureSecrets.provider),
      ),
    ).toBe(true);
    await fixture.runtime.vault.lock();
    const consume = vi.fn(() => Promise.resolve(true));
    await expect(broker.secret(fixture.references.provider, scope, consume)).rejects.toMatchObject({
      status: 'paused',
    });
    expect(consume).not.toHaveBeenCalled();
    await fixture.runtime.vault.unlock(workerPassphrase);
    const invalid: Array<() => Promise<Response>> = [
      () => Promise.reject(new Error('A fixture transport failure.')),
      () => Promise.resolve(new Response('{}', { status: 403 })),
      () => Promise.resolve(new Response('invalid JSON')),
      () => Promise.resolve(Response.json({ ready: false })),
      () => Promise.resolve(Response.json({ ready: true, unexpected: 'field' })),
    ];
    for (const fetcher of invalid) {
      const client = createExecutionBroker(
        fixture.database,
        fixture.config,
        fixture.workerId,
        fetcher,
      );
      await expect(client.ready(scope)).rejects.toMatchObject({ status: 'paused' });
    }
    const forged = createExecutionBroker(fixture.database, fixture.config, fixture.workerId, () =>
      Promise.resolve(Response.json({ secret: 'plaintext is not a capsule' })),
    );
    await expect(forged.secret(fixture.references.provider, scope, consume)).rejects.toMatchObject({
      code: 'VAULT_INVALID_INPUT',
    });
    expect(consume).not.toHaveBeenCalled();
    await fixture.abandon(work.run.id);
  });

  it('keeps work recoverable while the server is unavailable and streams a completed queued mission after recovery', async () => {
    const listener = await fixture.database.pool.connect();
    const tokens: string[] = [];
    listener.on('notification', (message) => {
      const event = z
        .object({ runId: z.string(), text: z.string(), step: z.number() })
        .parse(JSON.parse(message.payload!));
      tokens.push(event.text);
    });
    await listener.query('LISTEN run_token');
    try {
      fixture.setHealthReady(false);
      const before = fixture.modelRequests.length;
      const work = await fixture.mission('Produce a short worker response.');
      await fixture.start();
      await vi.waitFor(() =>
        expect(fixture.logs.some((line) => line.includes('EXECUTION_SERVER_UNAVAILABLE'))).toBe(
          true,
        ),
      );
      expect(fixture.modelRequests).toHaveLength(before);
      fixture.setHealthReady(true);
      const context = await fixture.finished(work.run.id);
      expect(context.run.costUsd).toBe(0);
      expect(tokens.join('')).toContain('Worker fixture completed.');
      const usage = await fixture.database.orm
        .select()
        .from(costLedger)
        .where(eq(costLedger.runId, work.run.id));
      expect(usage.length).toBeGreaterThanOrEqual(2);
      expect(
        usage.every((entry) => entry.providerId === 'worker-fixture' && entry.inputTokens > 0),
      ).toBe(true);
      expect(
        fixture.executionRequests.some(
          (request) =>
            request.runId === work.run.id && request.reference === fixture.references.provider,
        ),
      ).toBe(true);
    } finally {
      fixture.setHealthReady(true);
      await listener.query('UNLISTEN run_token');
      listener.release();
    }
  });

  it('executes the Comms email tool with an action-scoped credential and preserves its untrusted observation', async () => {
    const work = await fixture.mission('Read the fixture email and summarize it.', 'comms');
    await fixture.start();
    const context = await fixture.finished(work.run.id);
    expect(context.run.tainted).toBe(true);
    const [call] = await fixture.database.orm
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.runId, work.run.id));
    expect(call).toMatchObject({ toolName: 'email.read', status: 'done', attempt: 1 });
    expect(
      fixture.executionRequests.some(
        (request) =>
          request.scope === 'tool' &&
          request.executionId === call?.idempotencyKey &&
          request.reference === fixture.references.mail,
      ),
    ).toBe(true);
    expect(
      fixture.modelRequests.some((request) =>
        request.messages.some(
          (message) => message.role === 'tool' && String(message.content).includes('<untrusted>'),
        ),
      ),
    ).toBe(true);
    expect(fixture.credentials.length).toBeGreaterThan(0);
    expect(fixture.credentials.every(Boolean)).toBe(true);
    for (const secret of Object.values(fixtureSecrets)) {
      expect(JSON.stringify(fixture.modelRequests).includes(secret)).toBe(false);
      expect(JSON.stringify(call).includes(secret)).toBe(false);
      expect(fixture.logs.join('').includes(secret)).toBe(false);
    }
    expect(fixture.sent).toHaveLength(0);
  });

  it('polls IMAP with a trigger-scoped credential and advances the cursor without duplicating a mission', async () => {
    const trigger = await insertTrigger(fixture.database, fixture.userId, {
      projectId: fixture.project.id,
      name: 'Mailbox fixture',
      goal: 'Summarize this mailbox update.',
      agent: 'comms',
      enabled: true,
      config: { kind: 'imap', connectorId: 'mail', mailbox: 'INBOX', pollIntervalSeconds: 60 },
    });
    await fixture.start();
    await vi.waitFor(
      async () => {
        const [row] = await fixture.database.orm
          .select()
          .from(triggers)
          .where(eq(triggers.id, trigger.id));
        expect(row?.cursor).toEqual({ uidValidity: '17', lastUid: 1 });
      },
      { timeout: 8000, interval: 30 },
    );
    const [event] = await fixture.database.orm
      .select()
      .from(triggerEvents)
      .where(eq(triggerEvents.triggerId, trigger.id));
    expect(event?.missionId).toBeTruthy();
    const [run] = await fixture.database.orm
      .select()
      .from(runs)
      .where(eq(runs.missionId, event!.missionId!));
    expect((await fixture.finished(run!.id)).run.tainted).toBe(true);
    expect(
      fixture.executionRequests.some(
        (request) =>
          request.scope === 'trigger' &&
          request.executionId === trigger.id &&
          request.reference === fixture.references.mail,
      ),
    ).toBe(true);
    await fixture.database.orm
      .update(triggers)
      .set({ nextRunAt: new Date(0) })
      .where(eq(triggers.id, trigger.id));
    await vi.waitFor(() => expect(fixture.mailPolls).toContain(1), { timeout: 5000 });
    expect(
      await fixture.database.orm
        .select()
        .from(triggerEvents)
        .where(eq(triggerEvents.triggerId, trigger.id)),
    ).toHaveLength(1);
  });

  it('recovers Telegram polling, pairs once, handles project commands and preserves offsets across a worker restart', async () => {
    // Startup includes the real Windows private-key ACL check and an encrypted broker round trip.
    const waitForPolling = (check: () => Promise<void> | void) =>
      vi.waitFor(check, { timeout: 8000, interval: 30 });
    const committedOffset = (offset: number) =>
      waitForPolling(async () => {
        const [row] = await fixture.database.orm
          .select()
          .from(channelState)
          .where(eq(channelState.id, `telegram:bot:${fixtureBot}`));
        expect(row?.offset).toBe(offset);
      });
    await fixture.setting('channels', {
      ...fixture.runtime.settings.channels.value,
      telegramSecretRef: fixture.references.telegram,
    });
    const pairing = telegramPairSchema.parse(
      (
        await fixture.request('POST', '/api/channels/telegram/pair', {
          projectId: fixture.project.id,
        })
      ).json(),
    );
    fixture.setPollAvailable(false);
    await fixture.start();
    await waitForPolling(async () => {
      const [row] = await fixture.database.orm
        .select()
        .from(channelState)
        .where(eq(channelState.id, 'telegram'));
      expect(row?.lastError ?? '').toContain('polling is unavailable');
    });
    fixture.updates.push(fixture.message(10, pairing.command));
    fixture.setPollAvailable(true);
    await waitForPolling(async () =>
      expect(await fixture.database.orm.select().from(telegramBindings)).toHaveLength(1),
    );
    expect(await fixture.database.orm.select().from(telegramPairingCodes)).toHaveLength(0);
    await fixture.database.orm.insert(digests).values({
      id: workKey('dig'),
      userId: fixture.userId,
      projectId: fixture.project.id,
      title: 'Worker project digest',
      body: 'Only this project is included.',
      itemCount: 1,
      deliveryStatus: 'web',
    });
    const goal = 'A task submitted by the paired worker fixture.';
    fixture.updates.push(fixture.message(11, `@comms ${goal}`));
    await waitForPolling(async () =>
      expect(
        await fixture.database.orm.select().from(missions).where(eq(missions.goal, goal)),
      ).toHaveLength(1),
    );
    fixture.updates.push(fixture.message(12, '/status'), fixture.message(13, '/digest'));
    await waitForPolling(() =>
      expect(
        fixture.telegramMessages.some(
          (message) =>
            message.text.includes('Worker project digest') &&
            message.text.includes('Only this project'),
        ),
      ).toBe(true),
    );
    expect(fixture.telegramMessages.some((message) => message.text.includes(goal))).toBe(true);
    expect(
      fixture.telegramMessages.every((message) => message.chatId === String(fixtureSender)),
    ).toBe(true);
    await committedOffset(14);
    await fixture.stop();
    const beforeOffsets = fixture.offsets.length;
    await fixture.start();
    await waitForPolling(() => expect(fixture.offsets.length).toBeGreaterThan(beforeOffsets));
    expect(fixture.offsets[beforeOffsets]).toBeGreaterThanOrEqual(14);
    expect(
      await fixture.database.orm.select().from(missions).where(eq(missions.goal, goal)),
    ).toHaveLength(1);
    expect(
      fixture.telegramMessages.filter((message) => message.text.startsWith('Paired.')),
    ).toHaveLength(1);
    fixture.updates.push(fixture.message(14, '/stop'));
    await waitForPolling(async () =>
      expect((await getControl(fixture.database)).paused).toBe(true),
    );
    await waitForPolling(() =>
      expect(
        fixture.telegramMessages.some((message) => message.text.includes('All agents are paused')),
      ).toBe(true),
    );
    await committedOffset(15);
    expect(
      fixture.executionRequests.some(
        (request) =>
          request.scope === 'channel' && request.reference === fixture.references.telegram,
      ),
    ).toBe(true);
    await fixture.stop();
    const control = await getControl(fixture.database);
    await setControl(fixture.database, fixture.userId, false, control.version);
  });

  it('does not repeat uncertain or rejected notification deliveries and replays confirmed delivery results', async () => {
    const send = vi.fn(() => Promise.resolve({ messageId: 7 }));
    const uncertain = vi.fn(() => Promise.reject(new Error('A fixture response was lost.')));
    const rejected = vi.fn(() => Promise.reject(new TelegramError('REQUEST_REJECTED', 'not_sent')));
    for (const [id, callback, status] of [
      ['worker-delivered', send, 'delivered'],
      ['worker-uncertain', uncertain, 'uncertain'],
      ['worker-rejected', rejected, 'failed'],
    ] as const) {
      expect(
        await deliverOnce(fixture.database, id, 'telegram', String(fixtureSender), callback),
      ).toBe(status);
      expect(
        await deliverOnce(fixture.database, id, 'telegram', String(fixtureSender), callback),
      ).toBe(status);
      expect(callback).toHaveBeenCalledTimes(1);
    }
  });
});
