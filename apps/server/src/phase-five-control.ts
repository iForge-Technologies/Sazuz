import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  BrowserError,
  browserControlSchema,
  browserSessionId,
  browserSessionSchema,
  browserVersionSchema,
} from '@sazuz/core/browser';
import { publicBrowserSession } from '@sazuz/browser';
import {
  auditLog,
  browserProfiles,
  browserSessions,
  enqueueRun,
  getControl,
  runs,
  workKey,
} from '@sazuz/db';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import type { BrowserGateway } from './phase-five-execution.js';

export function createBrowserControl(runtime: PhaseOne, gateway: BrowserGateway) {
  const { database } = runtime;
  const transitions = new Set<string>();
  async function owned(userId: string, id: string) {
    const [row] = await database.orm
      .select({ session: browserSessions, profile: browserProfiles, run: runs })
      .from(browserSessions)
      .innerJoin(browserProfiles, eq(browserProfiles.id, browserSessions.profileId))
      .innerJoin(runs, eq(runs.id, browserSessions.runId))
      .where(and(eq(browserSessions.id, id), eq(browserProfiles.userId, userId)));
    if (
      !row ||
      row.session.status !== 'active' ||
      row.session.expiresAt.getTime() <= Date.now() ||
      row.profile.retired ||
      row.profile.generation !== row.session.profileGeneration ||
      (row.profile.expiresAt && row.profile.expiresAt.getTime() <= Date.now()) ||
      ['completed', 'cancelled', 'failed'].includes(row.run.status) ||
      (await runtime.vault.status()).locked
    )
      throw new BrowserError('BROWSER_DENIED');
    return row;
  }
  async function control(userId: string, id: string, input: z.infer<typeof browserControlSchema>) {
    if (transitions.has(id)) throw new BrowserError('BROWSER_CONFLICT');
    transitions.add(id);
    try {
      const original = await owned(userId, id);
      if (original.session.version !== input.version) throw new BrowserError('BROWSER_CONFLICT');
      if (input.action === 'handback') {
        if (original.session.control !== 'human' || original.run.claimKey)
          throw new BrowserError('BROWSER_CONFLICT');
        const response = await gateway.client({ mode: 'handback', sessionId: id });
        if (!response.ready || !response.state) throw new BrowserError('BROWSER_UNAVAILABLE');
        await gateway.saveState(original.session, response.state);
      }
      let resumed = false;
      await database.orm.transaction(async (tx) => {
        const [run] = await tx
          .select()
          .from(runs)
          .where(eq(runs.id, original.run.id))
          .for('update');
        const [session] = await tx
          .select()
          .from(browserSessions)
          .where(eq(browserSessions.id, id))
          .for('update');
        if (
          !run ||
          !session ||
          session.version !== input.version ||
          session.status !== 'active' ||
          session.expiresAt.getTime() <= Date.now() ||
          ['completed', 'cancelled', 'failed'].includes(run.status)
        )
          throw new BrowserError('BROWSER_CONFLICT');
        if (input.action === 'handback' && (run.claimKey || session.control !== 'human'))
          throw new BrowserError('BROWSER_CONFLICT');
        await tx
          .update(browserSessions)
          .set({
            control: input.action === 'take' ? 'human' : 'agent',
            sensitive: true,
            challenge: input.action === 'handback' ? null : session.challenge,
            version: session.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(browserSessions.id, id));
        if (input.action === 'take' && ['running', 'queued', 'paused'].includes(run.status)) {
          await tx
            .update(runs)
            .set({
              status: 'paused',
              reason: 'Human browser control is active.',
              version: run.version + 1,
              updatedAt: new Date(),
            })
            .where(eq(runs.id, run.id));
        } else if (
          input.action === 'handback' &&
          ['paused', 'queued'].includes(run.status) &&
          !(await getControl(database)).paused
        ) {
          const others = await tx
            .select({ id: browserSessions.id })
            .from(browserSessions)
            .where(
              and(
                eq(browserSessions.runId, run.id),
                eq(browserSessions.status, 'active'),
                eq(browserSessions.control, 'human'),
              ),
            );
          if (!others.length) {
            await tx
              .update(runs)
              .set({
                status: 'queued',
                reason: null,
                version: run.version + 1,
                updatedAt: new Date(),
              })
              .where(eq(runs.id, run.id));
            await enqueueRun(tx, run.id);
            resumed = true;
          }
        }
        await tx.insert(auditLog).values({
          id: workKey('aud'),
          actorId: userId,
          action: `browser.control.${input.action}`,
          target: id,
        });
        await tx.execute(sql`SELECT pg_notify('execution_changed',${run.id})`);
      });
      return { session: publicBrowserSession((await owned(userId, id)).session), resumed };
    } finally {
      transitions.delete(id);
    }
  }
  async function inputAllowed(userId: string, id: string) {
    const row = await owned(userId, id);
    if (
      transitions.has(id) ||
      row.session.control !== 'human' ||
      row.run.claimKey ||
      !['paused', 'waiting_approval', 'budget_exceeded'].includes(row.run.status) ||
      (await getControl(database)).paused
    )
      throw new BrowserError('BROWSER_DENIED');
    return row;
  }
  return { owned, control, inputAllowed, transitions };
}
export type BrowserControl = ReturnType<typeof createBrowserControl>;

export function registerBrowserControl(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  gateway: BrowserGateway,
  controls: BrowserControl,
) {
  const params = z.strictObject({ id: browserSessionId });
  app.post(
    '/api/browser/sessions/:id/control',
    {
      schema: {
        params,
        body: browserControlSchema,
        response: { 200: z.strictObject({ session: browserSessionSchema, resumed: z.boolean() }) },
      },
    },
    async (request) =>
      controls.control((await runtime.admin(request)).user.id, request.params.id, request.body),
  );
  app.delete(
    '/api/browser/sessions/:id',
    {
      schema: {
        params,
        body: browserVersionSchema,
        response: { 200: z.strictObject({ ok: z.literal(true) }) },
      },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      const row = await controls.owned(user.id, request.params.id);
      if (
        row.session.version !== request.body.version ||
        row.run.claimKey ||
        controls.transitions.has(row.session.id)
      )
        throw new BrowserError('BROWSER_CONFLICT');
      controls.transitions.add(row.session.id);
      try {
        const saved = await gateway.client({ mode: 'state', sessionId: row.session.id });
        await gateway.saveState(row.session, saved.state);
        await gateway.client({ mode: 'close', sessionId: row.session.id });
        await runtime.database.orm.insert(auditLog).values({
          id: workKey('aud'),
          actorId: user.id,
          action: 'browser.session.close',
          target: row.session.id,
        });
        return { ok: true as const };
      } finally {
        controls.transitions.delete(row.session.id);
      }
    },
  );
}
