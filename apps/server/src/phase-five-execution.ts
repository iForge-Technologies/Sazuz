import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { BrowserError, browserCommandSchema, browserObservationSchema } from '@sazuz/core/browser';
import { missionLimitsSchema } from '@sazuz/core/missions';
import {
  browserActions,
  browserProfiles,
  browserSessions,
  executionNonces,
  getControl,
  isWorkerHealthy,
  missionContext,
  toolCalls,
  valueHash,
  workKey,
} from '@sazuz/db';
import { createBrowserClient, createBrowserProfiles, type BrowserClient } from '@sazuz/browser';
import {
  browserWorkerRequestSchema,
  browserImageRequestSchema,
  verifyBrowserMessage,
  type BrowserRpcResult,
} from '@sazuz/browser/protocol';
import { durableCheckpointSchema, agentDefinitions } from '@sazuz/runtime';
import { acceptedActionReview, agentActionPermission, hasPinnedAgent } from '@sazuz/orchestrator';
import {
  consumeBrowserValue,
  sealBrowserValue,
  type BrowserBinding,
  type SecretReference,
} from '@sazuz/vault';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';

export function createBrowserGateway(
  runtime: PhaseOne,
  client: BrowserClient = createBrowserClient(runtime.config, () =>
    Promise.resolve(runtime.plumbing.operatorKey),
  ),
) {
  const { database, vault } = runtime;
  const profiles = createBrowserProfiles(database, vault);
  async function saveState(
    session: typeof browserSessions.$inferSelect,
    value: BrowserRpcResult['state'],
  ) {
    if (!value) return;
    const binding = value.binding;
    const [profile] = await database.orm
      .select()
      .from(browserProfiles)
      .where(eq(browserProfiles.id, session.profileId));
    if (
      !profile ||
      binding.sessionId !== session.id ||
      binding.runId !== session.runId ||
      binding.site !== profile.site ||
      binding.purpose !== 'state-return'
    )
      throw new BrowserError('BROWSER_DENIED');
    await consumeBrowserValue(runtime.plumbing.operatorKey, binding, value, (text) =>
      profiles.save(profile.id, session.profileGeneration, text),
    );
  }
  async function execute(input: unknown) {
    const request = browserWorkerRequestSchema.parse(input),
      command = browserCommandSchema.parse(request.command);
    const context = await missionContext(database, request.runId);
    if (
      !context ||
      context.run.status !== 'running' ||
      context.run.workerId !== request.workerId ||
      context.run.claimKey !== request.claimKey ||
      (await getControl(database)).paused ||
      (await vault.status()).locked
    )
      throw new BrowserError('BROWSER_DENIED');
    const checkpoint = durableCheckpointSchema.parse(context.run.checkpoint),
      loop = checkpoint.loop;
    const call = loop.pendingCalls[loop.nextCall];
    const callKey = `${request.runId}:${loop.step}:${loop.nextCall}`;
    if (
      callKey !== request.callKey ||
      !call ||
      call.name !== `browser.${command.operation}` ||
      valueHash(call.args) !== valueHash(command.args) ||
      checkpoint.agentId !== context.run.agentId ||
      !['operator', 'researcher'].includes(checkpoint.agentId)
    )
      throw new BrowserError('BROWSER_DENIED');
    const allowed: readonly string[] = agentDefinitions[checkpoint.agentId].allow;
    if (
      !allowed.some((prefix) =>
        prefix.endsWith('.') ? call.name.startsWith(prefix) : call.name === prefix,
      )
    )
      throw new BrowserError('BROWSER_DENIED');
    const [intent] = await database.orm
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.runId, request.runId), eq(toolCalls.idempotencyKey, callKey)));
    if (
      !intent ||
      !['intent', 'uncertain', 'retry_ready'].includes(intent.status) ||
      intent.toolName !== call.name ||
      intent.argsHash !== valueHash(call.args)
    )
      throw new BrowserError('BROWSER_DENIED');
    let session: typeof browserSessions.$inferSelect | undefined;
    if (!request.verify) {
      const effect = ['read', 'resolve', 'extract', 'screenshot', 'wait_for'].includes(
        command.operation,
      )
        ? 'read'
        : 'write';
      if (
        (await hasPinnedAgent(database, request.runId, checkpoint.agentId)) &&
        !(await agentActionPermission(
          database,
          context.project.userId,
          request.runId,
          checkpoint.agentId,
          call.name,
          call.args,
          effect,
          runtime.settings.connectors.value.accounts,
        ))
      )
        throw new BrowserError('BROWSER_DENIED');
      if (
        !(await acceptedActionReview(
          database,
          request.runId,
          callKey,
          call,
          { effect, scope: 'external' },
          runtime.settings,
        ))
      )
        throw new BrowserError('BROWSER_DENIED');
    }
    if (command.operation === 'open') {
      const [receipt] = await database.orm
        .select()
        .from(browserActions)
        .where(eq(browserActions.key, callKey));
      if (receipt)
        [session] = await database.orm
          .select()
          .from(browserSessions)
          .where(eq(browserSessions.id, receipt.sessionId));
    } else
      [session] = await database.orm
        .select()
        .from(browserSessions)
        .where(eq(browserSessions.id, command.args.sessionId));
    const profile = await profiles.owned(
      context.project.userId,
      command.operation === 'open' ? command.args.profileId : (session?.profileId ?? ''),
    );
    if (
      profile.retired ||
      profile.agentId !== checkpoint.agentId ||
      profile.projectId !== context.project.id ||
      (profile.expiresAt && profile.expiresAt.getTime() <= Date.now())
    )
      throw new BrowserError('BROWSER_DENIED');
    if (
      session &&
      (session.profileId !== profile.id ||
        session.runId !== request.runId ||
        session.agentId !== checkpoint.agentId ||
        session.profileGeneration !== profile.generation)
    )
      throw new BrowserError('BROWSER_DENIED');
    if (request.verify && !session) return { status: 'not_done' as const };
    const domains =
      runtime.settings.security.value.agentDomains.find(
        (entry) => entry.agentId === checkpoint.agentId,
      )?.domains ?? [];
    if (!domains.includes(new URL(profile.site).hostname)) throw new BrowserError('BROWSER_DENIED');
    const limits = missionLimitsSchema.parse(context.run.limits);
    const deadline = Date.parse(loop.startedAt) + limits.maxWallTimeSeconds * 1000;
    if (Date.now() >= deadline) throw new BrowserError('BROWSER_EXPIRED');
    if (!session) {
      if (command.operation !== 'open') throw new BrowserError('BROWSER_DENIED');
      [session] = await database.orm
        .select()
        .from(browserSessions)
        .where(
          and(
            eq(browserSessions.profileId, profile.id),
            eq(browserSessions.runId, request.runId),
            eq(browserSessions.status, 'opening'),
          ),
        );
    }
    if (!session) {
      // The database constraint reserves one active session per profile before Chromium starts.
      [session] = await database.orm
        .insert(browserSessions)
        .values({
          id: workKey('bsn'),
          profileId: profile.id,
          runId: request.runId,
          projectId: profile.projectId,
          agentId: profile.agentId,
          profileGeneration: profile.generation,
          serviceId: 'pending',
          expiresAt: new Date(
            Math.min(
              deadline,
              Date.now() + runtime.settings.browser.value.sessionMinutes * 60000,
              profile.expiresAt?.getTime() ?? Infinity,
            ),
          ),
        })
        .returning();
    }
    if (!session) throw new BrowserError('BROWSER_DENIED');
    const binding = (purpose: BrowserBinding['purpose']): BrowserBinding => ({
      sessionId: session.id,
      runId: request.runId,
      callKey,
      site: profile.site,
      purpose,
      nonce: randomUUID(),
      expiresAt: Date.now() + 45000,
    });
    let capsule: Awaited<ReturnType<typeof sealBrowserValue>> | undefined;
    if (command.operation === 'open' && !request.verify)
      capsule = await profiles.state(profile, (value) =>
        sealBrowserValue(runtime.plumbing.operatorKey, binding('state'), value),
      );
    if (command.operation === 'type' && 'secret' in command.args.value && !request.verify) {
      const reference = command.args.value.secret;
      if (
        !(Array.isArray(profile.secretRefs) && profile.secretRefs.includes(reference)) ||
        session.origin !== profile.site ||
        session.control !== 'agent'
      )
        throw new BrowserError('BROWSER_DENIED');
      capsule = await vault.withSecret(reference as SecretReference, 'user', (value) =>
        sealBrowserValue(runtime.plumbing.operatorKey, binding('secret'), value),
      );
    }
    const result = await client({
      mode: request.verify ? 'verify' : 'action',
      sessionId: session.id,
      callKey,
      command,
      ...(capsule ? { capsule } : {}),
      ...(command.operation === 'open'
        ? {
            launch: {
              sessionId: session.id,
              runId: request.runId,
              projectId: profile.projectId,
              agentId: profile.agentId,
              profileId: profile.id,
              site: profile.site,
              generation: profile.generation,
              expiresAt: session.expiresAt.getTime(),
              domains,
              poolSize: runtime.settings.browser.value.poolSize,
              screencastQuality: runtime.settings.browser.value.screencastQuality,
            },
          }
        : {}),
    });
    await saveState(session, result.state);
    return {
      status: result.status,
      ...(result.observation ? { observation: result.observation } : {}),
    };
  }
  async function image(input: unknown) {
    const request = browserImageRequestSchema.parse(input);
    const context = await missionContext(database, request.runId);
    if (
      !context ||
      context.run.status !== 'running' ||
      context.run.workerId !== request.workerId ||
      context.run.claimKey !== request.claimKey ||
      (await getControl(database)).paused ||
      (await vault.status()).locked
    )
      throw new BrowserError('BROWSER_DENIED');
    const saved = durableCheckpointSchema.parse(context.run.checkpoint).browserImage;
    if (
      !saved ||
      saved.sessionId !== request.sessionId ||
      saved.imageHandle !== request.imageHandle ||
      saved.sourceCallKey !== request.sourceCallKey
    )
      throw new BrowserError('BROWSER_DENIED');
    const [session] = await database.orm
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.id, request.sessionId));
    const [receipt] = await database.orm
      .select()
      .from(browserActions)
      .where(eq(browserActions.key, request.sourceCallKey));
    const [intent] = await database.orm
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.idempotencyKey, request.sourceCallKey));
    if (
      !session ||
      session.runId !== request.runId ||
      session.agentId !== context.run.agentId ||
      !receipt ||
      receipt.status !== 'done' ||
      receipt.sessionId !== session.id ||
      receipt.operation !== 'screenshot' ||
      !intent ||
      intent.status !== 'done' ||
      intent.runId !== request.runId ||
      intent.toolName !== 'browser.screenshot'
    )
      throw new BrowserError('BROWSER_DENIED');
    await profiles.owned(context.project.userId, session.profileId);
    if (browserObservationSchema.parse(receipt.result).imageHandle !== request.imageHandle)
      throw new BrowserError('BROWSER_DENIED');
    try {
      const result = await client({
        mode: 'image',
        sessionId: session.id,
        imageHandle: request.imageHandle,
      });
      return { image: result.image ?? null };
    } catch (error) {
      if (
        error instanceof BrowserError &&
        ['BROWSER_DENIED', 'BROWSER_EXPIRED'].includes(error.code)
      )
        return { image: null };
      throw error;
    }
  }
  return { execute, client, profiles, saveState, image };
}
export type BrowserGateway = ReturnType<typeof createBrowserGateway>;
export function registerBrowserExecution(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  gateway: BrowserGateway,
) {
  async function authenticate<T extends { workerId: string; nonce: string; expiresAt: number }>(
    message: T,
    purpose: 'worker' | 'worker-image',
    signature: unknown,
  ) {
    verifyBrowserMessage(runtime.plumbing.operatorKey, purpose, message, signature);
    if (!(await isWorkerHealthy(runtime.database, message.workerId)))
      throw new BrowserError('BROWSER_DENIED');
    await runtime.database.orm
      .delete(executionNonces)
      .where(sql`${executionNonces.expiresAt}<now()`);
    const nonce = await runtime.database.orm
      .insert(executionNonces)
      .values({ nonce: message.nonce, expiresAt: new Date(message.expiresAt) })
      .onConflictDoNothing()
      .returning();
    if (!nonce.length) throw new BrowserError('BROWSER_DENIED');
  }
  app.post('/internal/browser-execution', async (request) => {
    const message = browserWorkerRequestSchema.parse(request.body);
    await authenticate(message, 'worker', request.headers['x-sazuz-worker-signature']);
    return gateway.execute(message);
  });
  app.post('/internal/browser-image', async (request) => {
    const message = browserImageRequestSchema.parse(request.body);
    await authenticate(message, 'worker-image', request.headers['x-sazuz-worker-signature']);
    return gateway.image(message);
  });
}
