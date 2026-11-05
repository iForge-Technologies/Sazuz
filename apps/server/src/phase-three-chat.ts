import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { chatEventSchema, chatInput, type ChatEvent } from '@sazuz/core/work';
import {
  createMission,
  messages,
  missionContext,
  publicMessage,
  runSteps,
  threadContext,
} from '@sazuz/db';
import { secretRedactor } from '@sazuz/vault';
import { voiceGoal } from '@sazuz/runtime';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { RequestError } from './phase-one-errors.js';
import { emptyRequest, parseRequest, workPath } from './phase-three-shared.js';
import { createChatTokens, type ChatToken } from './phase-three-chat-tokens.js';

export type ChatHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const toolResultSchema = z.object({
  status: z.enum(['done', 'denied', 'waiting_approval', 'error']),
  output: z.unknown(),
});
const endedStatuses = new Set([
  'completed',
  'waiting_approval',
  'budget_exceeded',
  'paused',
  'failed',
  'cancelled',
]);
const bufferLimit = 262_144;

/** HTTP owns observation only. The transactional outbox and worker own execution. */
export function createDurableChat(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  options: { pollIntervalMs?: number; maxStreamMs?: number } = {},
): ChatHandler {
  const { database } = runtime;
  const tokens = createChatTokens(database);
  const observers = new Set<AbortController>();
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const maxStreamMs = options.maxStreamMs ?? 900_000;
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
    for (const observer of observers) observer.abort();
    await tokens.close();
  });

  return async (request, reply) => {
    const { user } = await runtime.admin(request);
    const { id } = parseRequest(workPath, request.params);
    const body = parseRequest(chatInput, request.body);
    parseRequest(emptyRequest, request.query);
    const context = await threadContext(database, user.id, id);
    if (!context) throw new RequestError('NOT_FOUND', 404, 'Thread unavailable.');
    if (closing) throw new RequestError('SERVER_CLOSING', 503, 'The server is restarting.');
    if ((await runtime.vault.status()).locked)
      throw new RequestError('VAULT_LOCKED', 423, 'Unlock the vault to use models.');
    await runtime.rateLimit('chat', 20);
    const budgets = runtime.settings.budgets.value;
    const goal = body.voiceReceiptId
      ? await voiceGoal(database, user.id, context.project.id, body.voiceReceiptId, body.content)
      : body.content;
    const mission = await createMission(
      database,
      user.id,
      {
        projectId: context.project.id,
        goal,
        requestId: body.requestId,
        agent: 'cos',
      },
      {
        maxSteps: budgets.maxSteps,
        maxCostUsd: budgets.perRunUsd,
        maxWallTimeSeconds: budgets.maxWallTimeSeconds,
      },
      body.voiceReceiptId ? 'voice' : 'chat',
      !!body.voiceReceiptId,
      id,
    );
    const observer = new AbortController();
    observers.add(observer);
    if (closing) observer.abort();
    const stopObservation = () => observer.abort();
    reply.raw.once('close', stopObservation);
    reply.raw.once('error', stopObservation);
    const link = `View mission: /missions/${mission.id}`;
    const bufferedTokens: ChatToken[] = [];
    let tokenBytes = 0;
    let completedStep = 0;
    let liveStep: number | undefined;
    let unsubscribe = () => {};
    const lastOrdinal = { value: 0, seen: new Set<string>() };
    const calls = new Map<string, { id: string; name: string; args: unknown }>();
    const deadline = Date.now() + maxStreamMs;
    let lastHeartbeat = Date.now();

    async function write(frame: string) {
      observer.signal.throwIfAborted();
      if (reply.raw.destroyed || reply.raw.writableEnded) throw new Error('Chat stream closed.');
      if (reply.raw.writableLength + Buffer.byteLength(frame) > bufferLimit)
        throw new Error('Chat stream buffer limit reached.');
      if (!reply.raw.write(frame))
        await once(reply.raw, 'drain', {
          signal: AbortSignal.any([observer.signal, AbortSignal.timeout(5000)]),
        });
    }
    const emit = (event: ChatEvent) =>
      write(`data: ${JSON.stringify(chatEventSchema.parse(secretRedactor.redact(event)))}\n\n`);

    async function flushTokens(step: number) {
      for (let index = 0; index < bufferedTokens.length;) {
        const token = bufferedTokens[index]!;
        if (token.step > step) {
          index++;
          continue;
        }
        bufferedTokens.splice(index, 1);
        tokenBytes -= Buffer.byteLength(token.text);
        if (token.step === step && token.step > completedStep)
          await emit({ type: 'text.delta', text: token.text });
      }
    }

    async function savedProgress() {
      for (;;) {
        const steps = await database.orm
          .select()
          .from(runSteps)
          .where(and(eq(runSteps.runId, mission.run.id), gte(runSteps.ordinal, lastOrdinal.value)))
          .orderBy(asc(runSteps.ordinal), asc(runSteps.createdAt), asc(runSteps.id))
          .limit(200);
        const pending = steps.filter((step) => !lastOrdinal.seen.has(step.id));
        if (!pending.length) return;
        const requestIds = pending
          .filter((step) => step.kind === 'assistant')
          .map((step) => `${mission.run.id}:${step.eventKey.split(':')[1]}`);
        const saved = requestIds.length
          ? await database.orm
              .select()
              .from(messages)
              .where(and(eq(messages.threadId, id), inArray(messages.requestId, requestIds)))
          : [];
        const byRequest = new Map(saved.map((message) => [message.requestId, message]));
        for (const step of pending) {
          observer.signal.throwIfAborted();
          if (step.kind === 'assistant') {
            const key = /^assistant:(\d+)$/.exec(step.eventKey);
            const number = key ? Number(key[1]) : 0;
            const row = byRequest.get(`${mission.run.id}:${number}`);
            if (!number || !row || row.role !== 'assistant')
              throw new Error('Saved chat response unavailable.');
            await flushTokens(number);
            const message = publicMessage(row);
            await emit({ type: 'message.completed', message });
            completedStep = number;
            liveStep = undefined;
            for (const [index, call] of message.toolCalls.entries()) {
              calls.set(`${number}:${index}`, call);
              await emit({ type: 'tool.call', ...call });
            }
          } else if (step.kind === 'tool') {
            const key = /^tool:(\d+):(\d+):/.exec(step.eventKey);
            const call = key ? calls.get(`${key[1]}:${key[2]}`) : undefined;
            if (!call) throw new Error('Saved tool call unavailable.');
            const result = toolResultSchema.parse(step.toolResult);
            await emit({
              type: 'tool.result',
              id: call.id,
              name: call.name,
              output: result.output,
              status: result.status,
            });
          }
          if (step.ordinal !== lastOrdinal.value) {
            lastOrdinal.value = step.ordinal;
            lastOrdinal.seen.clear();
          }
          lastOrdinal.seen.add(step.id);
        }
        if (steps.length < 200) return;
      }
    }

    try {
      unsubscribe = await tokens.subscribe(mission.run.id, (token) => {
        if (observer.signal.aborted || token.step <= completedStep) return;
        tokenBytes += Buffer.byteLength(token.text);
        if (tokenBytes > bufferLimit) {
          observer.abort();
          return;
        }
        bufferedTokens.push(token);
      });
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders()))
        if (value !== undefined) reply.raw.setHeader(name, value);
      reply.raw.socket?.setTimeout(0);
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      });
      await write(': connected\n\n');
      let lastStatus = '';
      while (!observer.signal.aborted && Date.now() < deadline) {
        const current = await missionContext(database, mission.run.id, user.id);
        if (!current) throw new Error('Saved mission unavailable.');
        await savedProgress();
        if (liveStep === undefined)
          liveStep = bufferedTokens.find((token) => token.step > completedStep)?.step;
        if (liveStep !== undefined) await flushTokens(liveStep);
        const status = `${current.run.status}:${current.run.reason ?? ''}`;
        if (lastStatus !== status) {
          await emit({
            type: 'run.status',
            status: current.run.status,
            message: `${current.run.reason ? `${current.run.reason} ` : ''}${link}`,
          });
          lastStatus = status;
        }
        if (endedStatuses.has(current.run.status)) return;
        if (Date.now() - lastHeartbeat >= 10_000) {
          await write(': keep-alive\n\n');
          lastHeartbeat = Date.now();
        }
        await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), undefined, {
          signal: observer.signal,
        });
      }
      throw new Error('Live chat observation ended.');
    } catch {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        database.logger.warn(
          { code: 'CHAT_OBSERVATION_INTERRUPTED', runId: mission.run.id },
          'Live chat observation ended. The saved mission remains available.',
        );
        if (reply.raw.writableLength < bufferLimit)
          reply.raw.write(
            `data: ${JSON.stringify({
              type: 'run.status',
              status: 'stream_interrupted',
              message: `Live updates ended. Your mission remains saved and can continue. ${link}`,
            } satisfies ChatEvent)}\n\n`,
          );
        else reply.raw.destroy();
      }
    } finally {
      unsubscribe();
      observers.delete(observer);
      reply.raw.removeListener('close', stopObservation);
      reply.raw.removeListener('error', stopObservation);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.socket?.setTimeout(5000);
        reply.raw.end();
      }
    }
  };
}
