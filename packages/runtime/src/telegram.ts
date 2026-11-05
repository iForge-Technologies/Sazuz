import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { SettingsDocument } from '@sazuz/config/settings';
import {
  createTelegramClient,
  createTelegramHandler,
  telegramPairingSchema,
  type TelegramClient,
  type TelegramPairing,
  type TelegramReplyMarkup,
} from '@sazuz/channels';
import {
  createMission,
  listMissions,
  getControl,
  setControl,
  telegramPairingCodes,
  telegramBindings,
  channelReceipts,
  channelState,
  digests,
  approvals,
  secrets,
  MissionError,
  missionContext,
  auditLog,
  valueHash,
  workKey,
  type Database,
} from '@sazuz/db';
import type { ToolRegistry } from '@sazuz/tools';
import { decideApproval } from './durable-store.js';
import { deliverOnce } from './notifications.js';
import type { ExecutionScope } from './broker.js';

export interface TelegramServiceOptions {
  database: Database;
  getSettings: () => SettingsDocument;
  tools: ToolRegistry;
  signal: AbortSignal;
  secret<T>(
    reference: string,
    scope: ExecutionScope,
    consume: (value: string) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T>;
  fetch?: typeof fetch;
  client?: TelegramClient;
}
export function createTelegramService(options: TelegramServiceOptions) {
  const { database, getSettings, signal } = options;
  const inbound = new AsyncLocalStorage<{ id: string; botId: string; transport: TelegramClient }>();
  let identityCache: { key: string; botId: string } | undefined;
  function client() {
    if (options.client) return options.client;
    const reference = getSettings().channels.value.telegramSecretRef;
    if (!reference) return null;
    return createTelegramClient({
      secretRef: reference,
      secret: <T>(ref: string, consume: (value: string) => Promise<T>) =>
        options.secret(
          ref,
          { runId: null, claimKey: null, scope: 'channel', executionId: 'telegram' },
          consume,
          signal,
        ),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      timeoutMs: 5000,
    });
  }
  async function identify(transport: TelegramClient) {
    const reference = getSettings().channels.value.telegramSecretRef;
    const [metadata] = reference
      ? await database.orm
          .select({ revision: secrets.revision })
          .from(secrets)
          .where(eq(secrets.id, reference.slice('secret://'.length)))
      : [];
    const key = `${reference ?? 'injected'}:${metadata?.revision ?? 0}`;
    if (identityCache?.key !== key)
      identityCache = { key, botId: await transport.getIdentity(signal) };
    return identityCache.botId;
  }
  const receipt = (kind: string, id: string | number) => {
    const current = inbound.getStore();
    if (!current) throw new Error('A Telegram update scope is required.');
    return `telegram:${current.botId}:${kind}:${id}`;
  };
  const lookup = async (input: { senderId: string; chatId: string }) => {
    const [row] = await database.orm
      .select()
      .from(telegramBindings)
      .where(
        and(
          eq(telegramBindings.senderId, input.senderId),
          eq(telegramBindings.chatId, input.chatId),
        ),
      );
    return row
      ? telegramPairingSchema.parse({
          userId: row.userId,
          projectId: row.projectId,
          senderId: row.senderId,
          chatId: row.chatId,
        })
      : null;
  };
  async function deliver(
    recipient: TelegramPairing,
    text: string,
    replyMarkup?: TelegramReplyMarkup,
  ) {
    const current = await lookup(recipient);
    if (
      !current ||
      current.userId !== recipient.userId ||
      current.projectId !== recipient.projectId
    )
      throw new Error('Paired recipient unavailable.');
    const transport = inbound.getStore()?.transport ?? client();
    if (!transport) throw new Error('Telegram is not configured.');
    return transport.sendMessage(
      { recipient, text, ...(replyMarkup ? { replyMarkup } : {}) },
      signal,
    );
  }
  const handler = createTelegramHandler({
    lookup,
    pair: (input) =>
      database.orm.transaction(async (tx) => {
        const [code] = await tx
          .delete(telegramPairingCodes)
          .where(
            and(
              eq(telegramPairingCodes.codeHash, input.codeHash),
              gt(telegramPairingCodes.expiresAt, new Date()),
            ),
          )
          .returning();
        if (!code) return null;
        const [row] = await tx
          .insert(telegramBindings)
          .values({
            id: workKey('bnd'),
            userId: code.userId,
            projectId: code.projectId,
            senderId: input.senderId,
            chatId: input.chatId,
          })
          .onConflictDoUpdate({
            target: telegramBindings.senderId,
            set: { userId: code.userId, projectId: code.projectId, chatId: input.chatId },
          })
          .returning();
        return telegramPairingSchema.parse({
          userId: row!.userId,
          projectId: row!.projectId,
          senderId: row!.senderId,
          chatId: row!.chatId,
        });
      }),
    // Receipts are committed only after handler effects; missions and callbacks have their own idempotency keys.
    consumeUpdate: async (updateId) =>
      !(
        await database.orm
          .select()
          .from(channelReceipts)
          .where(eq(channelReceipts.id, receipt('update', updateId)))
      ).length,
    consumeCallback: async (callbackId) =>
      !(
        await database.orm
          .select()
          .from(channelReceipts)
          .where(eq(channelReceipts.id, receipt('callback', callbackId)))
      ).length,
    audit: async (event) => {
      await database.orm.insert(auditLog).values({
        id: workKey('aud'),
        actorId: event.senderId ? `telegram:${event.senderId}` : 'telegram',
        action: `telegram.${event.kind}`,
        target: event.updateId === undefined ? 'inbound' : String(event.updateId),
      });
    },
    mission: async ({ pairing, text, idempotencyKey }) => {
      const match = /^@(researcher|comms|coder)\s+/i.exec(text);
      const agent = match?.[1]?.toLowerCase() as 'researcher' | 'comms' | 'coder' | undefined;
      const hash = valueHash(receipt('mission', idempotencyKey));
      const requestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      const caps = getSettings().budgets.value;
      const mission = await createMission(
        database,
        pairing.userId,
        {
          projectId: pairing.projectId,
          goal: match ? text.slice(match[0].length) : text,
          agent: agent ?? 'cos',
          requestId,
        },
        {
          maxSteps: caps.maxSteps,
          maxCostUsd: caps.perRunUsd,
          maxWallTimeSeconds: caps.maxWallTimeSeconds,
        },
        'telegram',
      );
      return `Mission created: ${mission.title}\n${getSettings().general.value.baseUrl}/missions/${mission.id}`;
    },
    status: async (pairing) =>
      (await listMissions(database, pairing.userId))
        .filter((mission) => mission.projectId === pairing.projectId)
        .slice(0, 10)
        .map((mission) => `${mission.title}: ${mission.run.status}`)
        .join('\n') || 'No missions in this project yet.',
    stop: async (pairing) => {
      const control = await getControl(database);
      if (!control.paused) await setControl(database, pairing.userId, true, control.version);
      return 'All agents are paused. Resume them from Sazuz when ready.';
    },
    digest: async (pairing) => {
      const [latest] = await database.orm
        .select()
        .from(digests)
        .where(and(eq(digests.userId, pairing.userId), eq(digests.projectId, pairing.projectId)))
        .orderBy(desc(digests.createdAt))
        .limit(1);
      return latest
        ? `${latest.title}\n\n${latest.body}`.slice(0, 3900)
        : 'No digest is available yet.';
    },
    decideApproval: async ({ pairing, approvalId, version, decision, callbackId }) => {
      const [approval] = await database.orm
        .select()
        .from(approvals)
        .where(eq(approvals.id, approvalId));
      const context = approval
        ? await missionContext(database, approval.runId, pairing.userId)
        : null;
      if (!context || context.project.id !== pairing.projectId) return 'denied';
      try {
        await decideApproval(
          database,
          pairing.userId,
          approvalId,
          { version, action: decision, note: 'Decision from the paired Telegram account.' },
          options.tools,
          getSettings,
        );
        await database.orm
          .insert(channelReceipts)
          .values({ id: receipt('callback', callbackId) })
          .onConflictDoNothing();
        return 'accepted';
      } catch (error) {
        if (
          error instanceof MissionError &&
          ['MISSION_CONFLICT', 'APPROVAL_INVALID', 'APPROVAL_EXPIRED'].includes(error.code)
        )
          return 'stale';
        throw error;
      }
    },
    reply: async (pairing, text) => {
      await deliverOnce(
        database,
        receipt('reply', inbound.getStore()!.id),
        'telegram',
        pairing.senderId,
        () => deliver(pairing, text.slice(0, 3900)),
      );
    },
    answerCallback: async (callbackId, text) => {
      const transport = inbound.getStore()?.transport ?? client();
      if (transport)
        await deliverOnce(database, receipt('answer', callbackId), 'telegram', callbackId, () =>
          transport.answerCallbackQuery({ callbackId, text }, signal),
        );
    },
  });
  async function handleForBot(update: unknown, botId: string, transport: TelegramClient) {
    const id =
      typeof update === 'object' && update !== null && 'update_id' in update
        ? String(update.update_id)
        : randomUUID();
    const result = await inbound.run({ id, botId, transport }, () => handler.handle(update));
    if (result.updateId !== undefined)
      await database.orm
        .insert(channelReceipts)
        .values({ id: `telegram:${botId}:update:${result.updateId}` })
        .onConflictDoNothing();
    return result;
  }
  async function handle(update: unknown) {
    const transport = client();
    if (!transport) throw new Error('Telegram is not configured.');
    return handleForBot(update, await identify(transport), transport);
  }
  async function poll() {
    const transport = client();
    if (!transport) return;
    const lease = await database.pool.connect();
    let owned = false;
    try {
      owned =
        (await lease.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(72839105) AS locked'))
          .rows[0]?.locked ?? false;
      if (!owned) return;
      const botId = await identify(transport);
      const stateId = `telegram:bot:${botId}`;
      const [state] = await database.orm
        .select()
        .from(channelState)
        .where(eq(channelState.id, stateId));
      const updates = await transport.getUpdates({
        offset: state?.offset ?? 0,
        timeoutSeconds: 1,
        signal,
      });
      for (const update of updates) {
        await handleForBot(update, botId, transport);
        await database.orm
          .insert(channelState)
          .values({ id: stateId, offset: update.update_id + 1, lastPollAt: new Date() })
          .onConflictDoUpdate({
            target: channelState.id,
            set: {
              offset: sql`greatest(${channelState.offset},${update.update_id + 1})`,
              lastPollAt: new Date(),
              lastError: null,
            },
          });
      }
      await database.orm
        .insert(channelState)
        .values({ id: 'telegram', lastPollAt: new Date() })
        .onConflictDoUpdate({
          target: channelState.id,
          set: { lastPollAt: new Date(), lastError: null },
        });
    } catch {
      if (!signal.aborted) {
        await database.orm
          .insert(channelState)
          .values({
            id: 'telegram',
            lastError: 'Telegram polling is unavailable. Check the bot token and vault.',
          })
          .onConflictDoUpdate({
            target: channelState.id,
            set: { lastError: 'Telegram polling is unavailable. Check the bot token and vault.' },
          });
        database.logger.warn(
          { code: 'TELEGRAM_POLL_UNAVAILABLE' },
          'Telegram polling could not finish.',
        );
      }
    } finally {
      if (owned) await lease.query('SELECT pg_advisory_unlock(72839105)');
      lease.release();
    }
  }
  return { handle, poll, deliver };
}
