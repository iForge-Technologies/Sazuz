import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  speakInputSchema,
  speechReceiptSchema,
  speechResultSchema,
  transcribeInputSchema,
  VoiceError,
} from '@sazuz/core/voice';
import { workflowNodeExecutionSchema } from '@sazuz/core/workflows';
import {
  auditLog,
  costLedger,
  getControl,
  messages,
  missionContext,
  projects,
  readSettings,
  remainingSpend,
  speechReceipts,
  threads,
  workflowRuns,
  workKey,
  type Database,
} from '@sazuz/db';
import { createSpeechAdapter, voiceWav, type SpeechAdapterOptions } from '@sazuz/llm';
import { evaluatePolicy } from '@sazuz/policy';
import { renderToolOutput } from '@sazuz/tools';
import { secretRedactor, type SecretReference, type Vault } from '@sazuz/vault';
import { durableCheckpointSchema } from './durable-contracts.js';

const receipt = (row: typeof speechReceipts.$inferSelect) =>
  speechReceiptSchema.parse({
    id: row.id,
    kind: row.kind,
    status: row.status,
    projectId: row.projectId,
    providerId: row.providerId,
    modelId: row.modelId,
    costUsd: row.costUsd,
    estimated: true,
    transcript: row.transcript,
    createdAt: row.createdAt.toISOString(),
  });

export async function voiceGoal(
  db: Database,
  userId: string,
  projectId: string,
  receiptId: string,
  content: string,
) {
  const [row] = await db.orm
    .select()
    .from(speechReceipts)
    .where(
      and(
        eq(speechReceipts.id, receiptId),
        eq(speechReceipts.userId, userId),
        eq(speechReceipts.projectId, projectId),
        eq(speechReceipts.kind, 'transcribe'),
        eq(speechReceipts.status, 'done'),
      ),
    );
  if (!row) throw new VoiceError('VOICE_NOT_FOUND');
  const goal = renderToolOutput({ output: secretRedactor.redactText(content), untrusted: true });
  if (goal.length > 24000) throw new VoiceError('VOICE_INVALID');
  return goal;
}

/** Human-requested inference uses the same serialized budget as other model calls. */
export function createSpeechService(options: {
  database: Database;
  vault: Vault;
  fetch?: SpeechAdapterOptions['fetch'];
}) {
  const db = options.database;
  const adapter = createSpeechAdapter({
    resolveSecret: (reference, consume) =>
      options.vault.withSecret(reference as SecretReference, 'user', consume),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  async function perform(userId: string, kind: 'transcribe' | 'speak', raw: unknown) {
    const parsed = (kind === 'transcribe' ? transcribeInputSchema : speakInputSchema).safeParse(
      raw,
    );
    if (!parsed.success) throw new VoiceError('VOICE_INVALID');
    const input = parsed.data;
    const inputHash = createHash('sha256')
      .update(JSON.stringify([kind, input]))
      .digest('hex');
    const audio = 'audio' in input ? Buffer.from(input.audio, 'base64') : null;
    let seconds = 0;
    if (audio) {
      try {
        if (audio.toString('base64') !== ('audio' in input ? input.audio : ''))
          throw new VoiceError('VOICE_INVALID');
        seconds = voiceWav(audio).seconds;
      } catch {
        audio.fill(0);
        throw new VoiceError('VOICE_INVALID');
      }
    }
    const lease = await db.pool.connect();
    let locked = false;
    try {
      locked =
        (await lease.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(72839102) AS locked'))
          .rows[0]?.locked ?? false;
      const [prior] = await db.orm
        .select()
        .from(speechReceipts)
        .where(
          and(eq(speechReceipts.userId, userId), eq(speechReceipts.requestId, input.requestId)),
        );
      if (prior) {
        if (prior.inputHash !== inputHash) throw new VoiceError('VOICE_CONFLICT');
        if (locked && prior.status === 'intent') {
          await db.orm
            .update(speechReceipts)
            .set({ status: 'uncertain', finishedAt: new Date() })
            .where(eq(speechReceipts.id, prior.id));
          prior.status = 'uncertain';
        }
        return speechResultSchema.parse({ receipt: receipt(prior), audio: null, mediaType: null });
      }
      if (!locked) throw new VoiceError('VOICE_BUSY');
      const settings = await readSettings(db);
      if (
        settings.speech.version !== input.speechVersion ||
        settings.providers.version !== input.providersVersion
      )
        throw new VoiceError('VOICE_CONFLICT');
      const configured =
        kind === 'transcribe'
          ? settings.speech.value.transcription
          : settings.speech.value.synthesis;
      if (!settings.speech.value.enabled || !configured || (await options.vault.status()).locked)
        throw new VoiceError('VOICE_UNAVAILABLE');
      const provider = settings.providers.value.items.find(
        (item) => item.id === configured.providerId && item.enabled,
      );
      if (!provider) throw new VoiceError('VOICE_UNAVAILABLE');
      const [message] =
        'messageId' in input
          ? await db.orm
              .select({ message: messages, project: projects })
              .from(messages)
              .innerJoin(threads, eq(threads.id, messages.threadId))
              .innerJoin(projects, eq(projects.id, threads.projectId))
              .where(
                and(
                  eq(messages.id, input.messageId),
                  eq(projects.userId, userId),
                  eq(messages.role, 'assistant'),
                ),
              )
          : [];
      const [project] =
        'projectId' in input
          ? await db.orm
              .select()
              .from(projects)
              .where(and(eq(projects.id, input.projectId), eq(projects.userId, userId)))
          : [message?.project];
      if (!project) throw new VoiceError('VOICE_NOT_FOUND');
      let privateOnly = project.privacy === 'private' || settings.models.value.preset === 'private';
      let tainted = true;
      const text = message?.message.content ?? '';
      if (kind === 'speak') {
        if (!z.string().trim().min(1).max(4000).safeParse(text).success)
          throw new VoiceError('VOICE_INVALID');
        const runId = message?.message.requestId?.split(':')[0];
        const source =
          runId && /^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(runId)
            ? await missionContext(db, runId, userId)
            : null;
        const checkpoint = durableCheckpointSchema.safeParse(source?.run.checkpoint);
        const node = workflowNodeExecutionSchema.safeParse(source?.run.workflowNode).data;
        const [workflow] = source
          ? await db.orm
              .select()
              .from(workflowRuns)
              .where(eq(workflowRuns.runId, node?.workflowRunId ?? source.run.id))
          : [];
        // Missing source evidence never makes a historical answer eligible for cloud playback.
        privateOnly ||=
          !source ||
          !checkpoint.success ||
          checkpoint.data.loop.privateOnly ||
          !!node?.privateOnly ||
          !!workflow?.privateOnly;
        tainted = source?.run.tainted ?? true;
      }
      if (privateOnly && provider.locality !== 'local') throw new VoiceError('VOICE_DENIED');
      const units = kind === 'transcribe' ? Math.ceil(seconds) : text.length;
      const rate =
        'pricePerMinuteUsd' in configured
          ? configured.pricePerMinuteUsd / 60
          : configured.pricePerMillionCharactersUsd / 1_000_000;
      const costUsd = provider.locality === 'local' ? 0 : units * rate;
      const budget = Math.min(
        settings.speech.value.maxRequestUsd,
        settings.budgets.value.perRunUsd,
        await remainingSpend(db, settings.budgets.value, project.id, project.budgetUsd),
      );
      if (costUsd > budget) throw new VoiceError('VOICE_BUDGET');
      const decision = evaluatePolicy({
        tool: `voice.${kind}`,
        effect: provider.locality === 'local' ? 'read' : 'send',
        scope: provider.locality === 'local' ? 'internal' : 'external',
        agentId: 'voice',
        projectId: project.id,
        tainted,
        preset: settings.security.value.preset,
        rules: settings.security.value.rules,
        args: {
          requestId: input.requestId,
          providerId: provider.id,
          modelId: configured.modelId,
          units,
          costUsd,
        },
        paused: (await getControl(db)).paused,
        budget: {
          remainingSteps: 1,
          remainingUsd: budget,
          remainingMs: settings.budgets.value.maxWallTimeSeconds * 1000,
          estimatedCostUsd: costUsd,
        },
      });
      await db.orm.insert(auditLog).values({
        id: workKey('aud'),
        actorId: userId,
        action: `policy.${decision.action}`,
        target: `voice:${input.requestId}`,
      });
      if (decision.action === 'deny') throw new VoiceError('VOICE_DENIED');
      if (decision.action === 'ask')
        await db.orm.insert(auditLog).values({
          id: workKey('aud'),
          actorId: userId,
          action: 'voice.approved',
          target: `voice:${input.requestId}`,
        });
      const started = Date.now(),
        id = workKey('spc'),
        ledgerId = workKey('cost');
      const [created] = await db.orm.transaction(async (tx) => {
        // Reserve the configured estimate before dispatch. Uncertain calls retain it across a crash.
        await tx.insert(costLedger).values({
          id: ledgerId,
          projectId: project.id,
          agentId: 'voice',
          providerId: provider.id,
          modelId: configured.modelId,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          costUsd,
          estimated: true,
          latencyMs: 0,
          status: 'uncertain',
        });
        return tx
          .insert(speechReceipts)
          .values({
            id,
            userId,
            projectId: project.id,
            requestId: input.requestId,
            kind,
            inputHash,
            providerId: provider.id,
            modelId: configured.modelId,
            settingsVersion: settings.speech.version,
            privateOnly,
            ledgerId,
            costUsd,
          })
          .returning();
      });
      if (!created) throw new VoiceError('VOICE_UNAVAILABLE');
      let resultAudio: Buffer | null = null;
      try {
        const selection = { provider, modelId: configured.modelId, privateOnly };
        const signal = AbortSignal.timeout(
          Math.min(60000, settings.budgets.value.maxWallTimeSeconds * 1000),
        );
        if (kind === 'transcribe' && audio)
          created.transcript = await adapter.transcribe(selection, audio, signal);
        else if ('voice' in configured)
          resultAudio = await adapter.speak(selection, text, configured.voice, signal);
        else throw new VoiceError('VOICE_INVALID');
        await db.orm.transaction(async (tx) => {
          await tx
            .update(speechReceipts)
            .set({ status: 'done', transcript: created.transcript, finishedAt: new Date() })
            .where(eq(speechReceipts.id, id));
          await tx
            .update(costLedger)
            .set({ status: 'completed', latencyMs: Date.now() - started })
            .where(eq(costLedger.id, ledgerId));
        });
        created.status = 'done';
        return speechResultSchema.parse({
          receipt: receipt(created),
          audio: resultAudio?.toString('base64') ?? null,
          mediaType: resultAudio ? 'audio/wav' : null,
        });
      } catch {
        await db.orm
          .update(speechReceipts)
          .set({ status: 'uncertain', transcript: null, finishedAt: new Date() })
          .where(eq(speechReceipts.id, id));
        created.status = 'uncertain';
        created.transcript = null;
        return speechResultSchema.parse({
          receipt: receipt(created),
          audio: null,
          mediaType: null,
        });
      } finally {
        resultAudio?.fill(0);
      }
    } finally {
      audio?.fill(0);
      let reusable = false;
      try {
        if (locked) await lease.query('SELECT pg_advisory_unlock(72839102)');
        reusable = true;
      } finally {
        lease.release(!reusable);
      }
    }
  }
  return {
    transcribe: (userId: string, input: unknown) => perform(userId, 'transcribe', input),
    speak: (userId: string, input: unknown) => perform(userId, 'speak', input),
    async history(userId: string) {
      return (
        await db.orm
          .select()
          .from(speechReceipts)
          .where(eq(speechReceipts.userId, userId))
          .orderBy(desc(speechReceipts.createdAt))
          .limit(30)
      ).map(receipt);
    },
  };
}
