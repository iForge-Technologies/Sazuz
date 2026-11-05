import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { missions, runs, toolCalls, valueHash, type Database } from '@sazuz/db';
import {
  styleSentPreviewSchema,
  styleSentSourceSchema,
  styleSourceSchema,
} from '@sazuz/core/style';
import { secretRedactor } from '@sazuz/vault';
import { SkillError } from './errors.js';
import { previewStyle } from './style.js';
import { styleProject } from './style-context.js';

const envelopeSchema = z.strictObject({
  output: z.unknown(),
  untrusted: z.literal(true),
  privateOnly: z.boolean().optional(),
});
const messageSchema = z.object({
  accountId: z.string().min(1).max(100),
  subject: z.string().max(4000),
  text: z.string().min(20).max(131072),
});
const gmailReceipt = z.strictObject({
  id: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200),
});
const smtpReceipt = z.strictObject({
  messageId: z.string().min(1).max(200),
  accepted: z.array(z.string().min(1).max(254)).min(1).max(100),
  rejected: z.array(z.string()).max(0),
  recipientStatus: z.literal('confirmed'),
});
const privacySchema = z.object({ loop: z.object({ privateOnly: z.boolean() }) });

async function sources(db: Database, userId: string, projectId: string, callIds?: string[]) {
  const project = await styleProject(db, userId, projectId);
  const rows = await db.orm
    .select({ call: toolCalls, checkpoint: runs.checkpoint, missionId: missions.id })
    .from(toolCalls)
    .innerJoin(runs, eq(runs.id, toolCalls.runId))
    .innerJoin(missions, eq(missions.id, runs.missionId))
    .where(
      and(
        eq(missions.projectId, project.id),
        eq(toolCalls.status, 'done'),
        eq(toolCalls.effect, 'send'),
        inArray(toolCalls.toolName, ['gmail.send', 'email.send']),
        ...(callIds ? [inArray(toolCalls.id, callIds)] : []),
      ),
    )
    .orderBy(desc(toolCalls.updatedAt), toolCalls.id)
    .limit(callIds?.length ?? 50);
  const seen = new Set<string>();
  const found = [];
  for (const { call, checkpoint, missionId } of rows) {
    const args = messageSchema.safeParse(call.args),
      result = envelopeSchema.safeParse(call.result);
    if (!args.success || !result.success) continue;
    const output = (call.toolName === 'gmail.send' ? gmailReceipt : smtpReceipt).safeParse(
      result.data.output,
    );
    if (!output.success) continue; // Uncertain, simulated and manually reconciled sends are not samples.
    const key = `${call.toolName}:${args.data.accountId}:${output.data.messageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = secretRedactor.redactText(args.data.text).trim().slice(0, 6000);
    if (text.length < 20) continue;
    const privacy = privacySchema.safeParse(checkpoint);
    const source = styleSentSourceSchema.parse({
      callId: call.id,
      runId: call.runId,
      missionId,
      projectId,
      tool: call.toolName,
      accountId: args.data.accountId,
      characters: text.length,
      subject: secretRedactor.redactText(args.data.subject).slice(0, 200),
      privateOnly:
        project.privacy === 'private' ||
        result.data.privateOnly === true ||
        !privacy.success ||
        privacy.data.loop.privateOnly,
      sentAt: call.updatedAt.toISOString(),
    });
    found.push({ source, text });
  }
  return { project, found };
}
export async function listStyleSources(db: Database, userId: string, projectId: string) {
  return (await sources(db, userId, projectId)).found.map(({ source }) => source);
}
export async function previewSentStyle(
  options: Omit<Parameters<typeof previewStyle>[0], 'sourceContext'>,
) {
  const input = styleSentPreviewSchema.parse(options.input);
  const { project, found } = await sources(
    options.database,
    options.userId,
    input.projectId,
    input.callIds,
  );
  if (found.length !== input.callIds.length) throw new SkillError('STYLE_SOURCE_NOT_FOUND');
  // Stable order and exact excerpt hashes make a receipt independent of UI selection order.
  found.sort((a, b) => a.source.callId.localeCompare(b.source.callId));
  const length = Math.min(6000, Math.floor(12000 / found.length));
  const samples = found.map(({ text }) => text.slice(0, length));
  return previewStyle({
    ...options,
    input: {
      requestId: input.requestId,
      samples,
      privateOnly: input.privateOnly || found.some(({ source }) => source.privateOnly),
    },
    sourceContext: {
      projectId: project.id,
      projectCap: project.budgetUsd,
      sources: found.map(({ source }, i) =>
        styleSourceSchema.parse({
          callId: source.callId,
          runId: source.runId,
          missionId: source.missionId,
          projectId: project.id,
          tool: source.tool,
          accountId: source.accountId,
          sha256: valueHash(samples[i]),
          characters: samples[i]!.length,
        }),
      ),
    },
  });
}
