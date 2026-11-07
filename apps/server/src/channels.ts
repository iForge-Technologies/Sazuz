import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  acceptsSender,
  ChannelError,
  channelSendSchema,
  inboundSchema,
  parseChannelPayload,
  sendChannelText,
  verifyChannelSignature,
  type ChannelInbound,
} from '@sazuz/channels';
import { connectWhatsAppQr, type QrStatus } from '@sazuz/channels/whatsapp-qr';
import {
  channelConnectionSchema,
  integrationId,
  type ChannelConnection,
} from '@sazuz/config/integrations';
import {
  auditLog,
  channelInbox,
  channelSessions,
  executionNonces,
  getControl,
  insertMission,
  isWorkerHealthy,
  missionContext,
  missions,
  projects,
  readSettings,
  runs,
  runSteps,
  saveSetting,
  toolCalls,
  valueHash,
  workKey,
} from '@sazuz/db';
import { deliverOnce, durableCheckpointSchema } from '@sazuz/runtime';
import { workflowAllows } from '@sazuz/workflows/s2a';
import { agentRoleSchema } from '@sazuz/core/agents';
import { acceptedActionReview, agentActionPermission, hasPinnedAgent } from '@sazuz/orchestrator';
import {
  secretRedactor,
  verifyExecutionRequest,
  VaultError,
  type SecretReference,
} from '@sazuz/vault';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { sameToken } from './phase-one.js';
import { RequestError } from './phase-one-errors.js';
import { parseRequest } from './phase-three-shared.js';

const path = z.strictObject({ id: integrationId });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const uuid = (value: string) => {
  const h = hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const disconnected: QrStatus = { state: 'disconnected', qr: null, expiresAt: null };
type QrConnection = Awaited<ReturnType<typeof connectWhatsAppQr>>;

export function registerChannels(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  overrides: { fetch?: typeof fetch } = {},
) {
  const db = runtime.database;
  const sessions = new Map<
    string,
    { client: QrConnection; release: () => void; fingerprint: string }
  >();
  const retryAfter = new Map<string, number>();
  const starting = new Set<string>();
  let stopping = false;
  const secret = <T>(reference: string, consume: (value: string) => Promise<T>) =>
    runtime.vault.withSecret(reference as SecretReference, 'user', consume);
  const report = (id: string) =>
    db.logger.error(
      { code: 'CHANNEL_SESSION_FAILED', connectionId: id },
      'The channel session needs attention.',
    );
  const current = (id: string) =>
    runtime.settings.channels.value.connections.find((item) => item.id === id);

  async function deleteQrSecret(reference: string) {
    try {
      await runtime.vault.delete(reference.slice(9));
    } catch (error) {
      // A crash may have removed the secret before its session pointer was deleted.
      if (!(error instanceof VaultError) || error.code !== 'VAULT_SECRET_NOT_FOUND') throw error;
    }
  }

  async function clearQrAuth(id: string) {
    for (const row of await db.orm
      .select()
      .from(channelSessions)
      .where(sql`split_part(${channelSessions.connectionId}, ':', 1) = ${id}`)) {
      await deleteQrSecret(row.secretRef);
      await db.orm
        .delete(channelSessions)
        .where(eq(channelSessions.connectionId, row.connectionId));
    }
  }

  async function receive(connection: ChannelConnection, raw: ChannelInbound) {
    const event = inboundSchema.parse(raw);
    if (!acceptsSender(connection, event)) {
      await db.orm.insert(auditLog).values({
        id: workKey('aud'),
        actorId: 'channel',
        action: 'channel.sender_rejected',
        target: connection.id,
      });
      return false;
    }
    const id = `${connection.id}:${hash(event.id)}`;
    return db.orm.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${id},9))`);
      if ((await tx.select().from(channelInbox).where(eq(channelInbox.id, id))).length)
        return false;
      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, connection.projectId));
      if (!project)
        throw new RequestError(
          'CHANNEL_PROJECT_UNAVAILABLE',
          409,
          'Select an available channel project.',
        );
      const budgets = runtime.settings.budgets.value;
      const missionId = await insertMission(
        tx,
        project.userId,
        {
          projectId: project.id,
          title: `${connection.name}: new task`,
          goal: event.text,
          agent: 'cos',
          requestId: uuid(id),
        },
        {
          maxSteps: budgets.maxSteps,
          maxCostUsd: budgets.perRunUsd,
          maxWallTimeSeconds: budgets.maxWallTimeSeconds,
        },
        `channel:${connection.id}`,
        true,
      );
      await tx.insert(channelInbox).values({
        id,
        connectionId: connection.id,
        sender: event.sender,
        conversation: event.conversation,
        missionId,
      });
      await tx.insert(auditLog).values({
        id: workKey('aud'),
        actorId: project.userId,
        action: 'channel.task_received',
        target: id,
      });
      return true;
    });
  }

  async function startQr(connection: ChannelConnection) {
    if (starting.has(connection.id)) return;
    const existing = sessions.get(connection.id);
    if (existing && !['error', 'disconnected'].includes(existing.client.status().state)) return;
    if (existing) {
      await existing.client.close();
      existing.release();
      sessions.delete(connection.id);
    }
    if (!connection.enabled || connection.kind !== 'whatsapp-qr')
      throw new RequestError('CHANNEL_DISABLED', 409, 'Enable the WhatsApp QR connection first.');
    starting.add(connection.id);
    const lease = await db.pool.connect().catch((error: unknown) => {
      starting.delete(connection.id);
      throw error;
    });
    try {
      const owned =
        (
          await lease.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock(hashtextextended($1,11)) AS locked',
            [connection.id],
          )
        ).rows[0]?.locked ?? false;
      if (!owned)
        throw new RequestError('CHANNEL_BUSY', 409, 'This session is active on another server.');
      if ((await runtime.vault.status()).locked)
        throw new RequestError('VAULT_LOCKED', 423, 'Unlock the vault to connect WhatsApp.');
      const fingerprint = valueHash(connection);
      const client = await connectWhatsAppQr({
        storage: {
          clear: () => clearQrAuth(connection.id),
          async read(key) {
            const [row] = await db.orm
              .select()
              .from(channelSessions)
              .where(eq(channelSessions.connectionId, `${connection.id}:${hash(key)}`));
            return row ? secret(row.secretRef, (value) => Promise.resolve(value)) : null;
          },
          async write(key, value) {
            const id = `${connection.id}:${hash(key)}`;
            const [row] = await db.orm
              .select()
              .from(channelSessions)
              .where(eq(channelSessions.connectionId, id));
            if (value === null) {
              if (row) {
                await deleteQrSecret(row.secretRef);
                await db.orm.delete(channelSessions).where(eq(channelSessions.connectionId, id));
              }
              return;
            }
            const actualRevision = row
              ? (await runtime.vault.list()).find((item) => item.reference === row.secretRef)
                  ?.revision
              : undefined;
            const metadata = row
              ? await runtime.vault.update(
                  row.secretRef.slice(9),
                  { name: `WhatsApp session ${connection.id}`, value },
                  actualRevision ?? row.revision,
                )
              : await runtime.vault.create({
                  name: `WhatsApp session ${connection.id}`,
                  value,
                  createdBy: 'channel-session',
                });
            await db.orm
              .insert(channelSessions)
              .values({
                connectionId: id,
                secretRef: metadata.reference,
                revision: metadata.revision,
              })
              .onConflictDoUpdate({
                target: channelSessions.connectionId,
                set: {
                  secretRef: metadata.reference,
                  revision: metadata.revision,
                  updatedAt: new Date(),
                },
              });
          },
        },
        receive: async (event) => {
          const config = current(connection.id);
          if (config && valueHash(config) === fingerprint) await receive(config, event);
        },
        onError: () => report(connection.id),
      });
      sessions.set(connection.id, { client, fingerprint, release: () => lease.release(true) });
    } catch (error) {
      lease.release(true);
      throw error;
    } finally {
      starting.delete(connection.id);
    }
  }

  async function send(connection: ChannelConnection, conversation: string, text: string) {
    if (connection.kind === 'whatsapp-qr') {
      const session = sessions.get(connection.id);
      if (
        !session ||
        session.fingerprint !== valueHash(connection) ||
        (await runtime.vault.status()).locked
      )
        throw new ChannelError('CHANNEL_UNAVAILABLE', 'not_sent');
      return session.client.send(conversation, secretRedactor.redactText(text));
    }
    return sendChannelText(
      connection,
      conversation,
      secretRedactor.redactText(text),
      secret,
      overrides.fetch,
    );
  }

  app.get('/api/channels/connections', async (request) => {
    await runtime.admin(request);
    const settings = await readSettings(db);
    return { version: settings.channels.version, connections: settings.channels.value.connections };
  });
  app.put('/api/channels/connections', async (request) => {
    const { user } = await runtime.admin(request);
    const body = parseRequest(
      z.strictObject({
        version: z.number().int().nonnegative(),
        connections: z.array(channelConnectionSchema).max(30),
      }),
      request.body,
    );
    for (const connection of body.connections) {
      const [project] = await db.orm
        .select()
        .from(projects)
        .where(and(eq(projects.id, connection.projectId), eq(projects.userId, user.id)));
      if (!project)
        throw new RequestError('CHANNEL_PROJECT_UNAVAILABLE', 400, 'Select one of your projects.');
      if (
        connection.enabled &&
        (!connection.allowedSenders.length ||
          (connection.kind !== 'whatsapp-qr' && !connection.secretRef) ||
          (connection.kind === 'discord' && (!connection.publicKey || !connection.applicationId)) ||
          (connection.kind === 'slack' &&
            (!connection.signingSecretRef || !connection.applicationId)) ||
          (connection.kind === 'whatsapp-cloud' &&
            (!connection.signingSecretRef ||
              !connection.verifyTokenRef ||
              !connection.phoneNumberId)))
      )
        throw new RequestError(
          'CHANNEL_INCOMPLETE',
          400,
          'Complete credentials, identifiers and allowed senders before enabling the channel.',
        );
    }
    const settings = await readSettings(db);
    const saved = await saveSetting(db, {
      namespace: 'channels',
      value: { ...settings.channels.value, connections: body.connections },
      expectedVersion: body.version,
      actorId: user.id,
    });
    return { version: saved.version, connections: saved.value.connections };
  });
  app.post('/api/channels/:id/connect', async (request) => {
    await runtime.admin(request);
    const { id } = parseRequest(path, request.params);
    parseRequest(z.strictObject({}), request.body);
    const connection = current(id);
    if (!connection) throw new RequestError('NOT_FOUND', 404, 'Channel unavailable.');
    await startQr(connection);
    return { ok: true };
  });
  app.get('/api/channels/:id/status', async (request) => {
    await runtime.admin(request);
    const { id } = parseRequest(path, request.params);
    if (!current(id)) throw new RequestError('NOT_FOUND', 404, 'Channel unavailable.');
    return sessions.get(id)?.client.status() ?? disconnected;
  });
  app.post('/api/channels/:id/disconnect', async (request) => {
    await runtime.admin(request);
    const { id } = parseRequest(path, request.params);
    parseRequest(z.strictObject({}), request.body);
    const session = sessions.get(id);
    if (starting.has(id))
      throw new RequestError(
        'CHANNEL_BUSY',
        409,
        'The session is still connecting. Try again shortly.',
      );
    const lease = session ? undefined : await db.pool.connect();
    try {
      if (lease) {
        const locked = (
          await lease.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock(hashtextextended($1,11)) AS locked',
            [id],
          )
        ).rows[0]?.locked;
        if (!locked)
          throw new RequestError('CHANNEL_BUSY', 409, 'This session is active on another server.');
      }
      if (session) {
        await session.client.close(true);
        session.release();
        sessions.delete(id);
      }
      await clearQrAuth(id);
    } finally {
      lease?.release(true);
    }
    return { ok: true };
  });

  void app.register((hooks, _options, done) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: 131_072 },
      (_request, body, callback) => callback(null, body),
    );
    hooks.get('/channels/hooks/:id', async (request, reply) => {
      const { id } = parseRequest(path, request.params);
      const connection = current(id);
      const query = parseRequest(
        z.object({
          'hub.mode': z.literal('subscribe'),
          'hub.verify_token': z.string().max(2000),
          'hub.challenge': z.string().max(2000),
        }),
        request.query,
      );
      if (
        !connection?.enabled ||
        connection.kind !== 'whatsapp-cloud' ||
        !connection.verifyTokenRef
      )
        throw new RequestError('NOT_FOUND', 404, 'Channel unavailable.');
      const valid = await secret(connection.verifyTokenRef, (value) =>
        Promise.resolve(sameToken(value, query['hub.verify_token'])),
      );
      if (!valid) throw new RequestError('SIGNATURE_INVALID', 401, 'Channel verification failed.');
      return reply.type('text/plain').send(query['hub.challenge']);
    });
    hooks.post('/channels/hooks/:id', async (request, reply) => {
      const { id } = parseRequest(path, request.params);
      const connection = current(id);
      await runtime.rateLimit(`channel-hook:${id}`, 120);
      if (!connection?.enabled || connection.kind === 'whatsapp-qr')
        throw new RequestError('NOT_FOUND', 404, 'Channel unavailable.');
      const bytes = parseRequest(z.instanceof(Uint8Array), request.body);
      try {
        if (connection.kind === 'discord')
          verifyChannelSignature(connection, request.headers, bytes);
        else if (connection.signingSecretRef)
          await secret(connection.signingSecretRef, (value) => {
            verifyChannelSignature(connection, request.headers, bytes, value);
            return Promise.resolve();
          });
        else throw new ChannelError('SIGNATURE_INVALID');
        const parsed = parseChannelPayload(
          connection,
          JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown,
        );
        if (parsed.discordPing) return { type: 1 };
        if (parsed.challenge) return { challenge: parsed.challenge };
        let accepted = false;
        for (const event of parsed.events)
          accepted = (await receive(connection, event)) || accepted;
        return connection.kind === 'discord'
          ? {
              type: 4,
              data: {
                content: accepted
                  ? 'Task accepted. Follow its progress in Sazuz; the result will appear here.'
                  : 'This task was already received or this sender is not enabled.',
                flags: 64,
                allowed_mentions: { parse: [] },
              },
            }
          : reply.code(200).send({ ok: true });
      } catch (error) {
        if (error instanceof ChannelError)
          throw new RequestError(
            error.code,
            error.code === 'SIGNATURE_INVALID' ? 401 : 400,
            'Channel request validation failed.',
          );
        if (error instanceof SyntaxError)
          throw new RequestError('PAYLOAD_INVALID', 400, 'Invalid channel payload.');
        throw error;
      }
    });
    done();
  });

  app.post('/internal/channel-send', async (request) => {
    const deny = () =>
      new RequestError('EXECUTION_DENIED', 403, 'This channel execution is unavailable.');
    let execution;
    try {
      execution = verifyExecutionRequest(
        runtime.plumbing.operatorKey,
        request.body,
        request.headers['x-sazuz-worker-signature'],
      );
    } catch {
      throw deny();
    }
    if (
      execution.scope !== 'tool' ||
      execution.reference !== null ||
      !execution.runId ||
      !execution.claimKey ||
      execution.workspaceId !== (await runtime.state()).workspaceId ||
      !(await isWorkerHealthy(db, execution.workerId)) ||
      (await getControl(db)).paused
    )
      throw deny();
    const context = await missionContext(db, execution.runId);
    const state = durableCheckpointSchema.safeParse(context?.run.checkpoint);
    if (
      !context ||
      !state.success ||
      context.run.workerId !== execution.workerId ||
      context.run.claimKey !== execution.claimKey ||
      context.run.status !== 'running'
    )
      throw deny();
    const loop = state.data.loop;
    const call = loop.pendingCalls[loop.nextCall];
    if (
      !call ||
      call.name !== 'channel.send' ||
      execution.executionId !== `${execution.runId}:${loop.step}:${loop.nextCall}` ||
      (!state.data.workflow && context.run.agentId !== 'comms') ||
      (state.data.workflow && !workflowAllows(state.data.workflow, call.name))
    )
      throw deny();
    const [intent] = await db.orm
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.idempotencyKey, execution.executionId));
    if (
      !intent ||
      intent.status !== 'intent' ||
      intent.runId !== context.run.id ||
      intent.effect !== 'send' ||
      intent.toolName !== call.name ||
      intent.argsHash !== valueHash(call.args)
    )
      throw deny();
    const agent = agentRoleSchema.parse(context.run.agentId);
    if (
      ((await hasPinnedAgent(db, context.run.id, agent)) &&
        !(await agentActionPermission(
          db,
          context.project.userId,
          context.run.id,
          agent,
          call.name,
          call.args,
          'send',
          runtime.settings.connectors.value.accounts,
        ))) ||
      !(await acceptedActionReview(
        db,
        context.run.id,
        execution.executionId,
        call,
        { effect: 'send', scope: 'external' },
        runtime.settings,
      ))
    )
      throw deny();
    const args = parseRequest(channelSendSchema, call.args);
    const connection = current(args.connectionId);
    if (
      !connection?.enabled ||
      connection.projectId !== context.project.id ||
      (connection.allowedConversations.length
        ? !connection.allowedConversations.includes(args.conversation.split(':')[0]!)
        : !connection.allowedSenders.includes(args.conversation))
    )
      throw deny();
    const accepted = await db.orm
      .insert(executionNonces)
      .values({ nonce: execution.nonce, expiresAt: new Date(execution.expiresAt) })
      .onConflictDoNothing()
      .returning();
    if (!accepted.length) throw deny();
    return send(connection, args.conversation, args.text);
  });

  let busy = false;
  const tick = async () => {
    if (busy || stopping) return;
    busy = true;
    try {
      const locked = (await runtime.vault.status()).locked;
      for (const [id, session] of sessions) {
        const connection = current(id);
        if (locked || !connection?.enabled || valueHash(connection) !== session.fingerprint) {
          await session.client.close();
          session.release();
          sessions.delete(id);
        }
      }
      if (locked) return;
      for (const connection of runtime.settings.channels.value.connections.filter(
        (item) => item.enabled && item.kind === 'whatsapp-qr',
      )) {
        if (sessions.has(connection.id) || (retryAfter.get(connection.id) ?? 0) > Date.now())
          continue;
        const [stored] = await db.orm
          .select()
          .from(channelSessions)
          .where(eq(channelSessions.connectionId, `${connection.id}:${hash('creds')}`));
        if (stored) {
          retryAfter.set(connection.id, Date.now() + 60_000);
          try {
            await startQr(connection);
          } catch {
            report(connection.id);
          }
        }
      }
      const pending = await db.orm
        .select({ inbox: channelInbox, run: runs, mission: missions })
        .from(channelInbox)
        .innerJoin(missions, eq(missions.id, channelInbox.missionId))
        .innerJoin(runs, eq(runs.missionId, missions.id))
        .where(
          and(
            eq(channelInbox.status, 'pending'),
            sql`${runs.parentRunId} IS NULL`,
            sql`${runs.status} IN ('completed','failed','cancelled','waiting_approval','budget_exceeded')`,
            sql`NOT EXISTS (SELECT 1 FROM delivery_intents WHERE id='channel:' || ${channelInbox.id} || ':' || ${runs.status})`,
          ),
        )
        .limit(20);
      for (const { inbox, run, mission } of pending) {
        const connection = current(inbox.connectionId);
        if (
          !connection ||
          connection.projectId !== mission.projectId ||
          !acceptsSender(connection, {
            id: inbox.id,
            sender: inbox.sender,
            conversation: inbox.conversation,
            text: 'notification',
          })
        )
          continue;
        const [last] = await db.orm
          .select()
          .from(runSteps)
          .where(and(eq(runSteps.runId, run.id), eq(runSteps.kind, 'assistant')))
          .orderBy(desc(runSteps.ordinal))
          .limit(1);
        const link = `${runtime.settings.general.value.baseUrl.replace(/\/$/, '')}/missions/${mission.id}`;
        const text =
          run.status === 'completed'
            ? `${(last?.content || 'The task completed.').slice(0, 1500)}\n\n${link}`
            : `Task ${run.status.replaceAll('_', ' ')}. Review the mission and any approval: ${link}`;
        const delivery = await deliverOnce(
          db,
          `channel:${inbox.id}:${run.status}`,
          connection.kind,
          inbox.conversation,
          () => send(connection, inbox.conversation, text),
        );
        if (['completed', 'failed', 'cancelled'].includes(run.status))
          await db.orm
            .update(channelInbox)
            .set({ status: delivery })
            .where(eq(channelInbox.id, inbox.id));
      }
    } catch {
      db.logger.error(
        { code: 'CHANNEL_DELIVERY_RETRY' },
        'Channel delivery will retry with durable receipts.',
      );
    } finally {
      busy = false;
    }
  };
  let backgroundTick = Promise.resolve();
  const timer = setInterval(() => {
    if (!busy && !stopping) backgroundTick = tick();
  }, 1500);
  timer.unref();
  app.addHook('onClose', async () => {
    stopping = true;
    clearInterval(timer);
    await backgroundTick;
    for (const session of sessions.values()) {
      await session.client.close();
      session.release();
    }
    sessions.clear();
  });
  return { receive, tick };
}
