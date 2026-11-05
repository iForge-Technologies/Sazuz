import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { SettingsDocument } from '@sazuz/config/settings';
import { taskAssignmentSchema } from '@sazuz/core/graphs';
import { reviewEvidenceSchema, type ReviewEvidence } from '@sazuz/core/reviews';
import {
  artifacts,
  auditLog,
  kbChunks,
  kbSources,
  missionTasks,
  runs,
  skills,
  skillVersions,
  styleProfiles,
  toolCalls,
  valueHash,
  workKey,
  type Database,
  type missionContext,
} from '@sazuz/db';
import { evaluatePolicy } from '@sazuz/policy';
import { fetchPublicText, type SafeNetworkDependencies } from '@sazuz/tools';
import { secretRedactor } from '@sazuz/vault';
import { agentActionPermission } from './agents.js';

export type ReviewContext = NonNullable<Awaited<ReturnType<typeof missionContext>>>;
export async function acceptedStyle(db: Database, userId: string) {
  const [row] = await db.orm
    .select({ profile: styleProfiles, version: skillVersions })
    .from(styleProfiles)
    .innerJoin(
      skills,
      and(eq(skills.id, styleProfiles.skillId), eq(skills.revision, styleProfiles.revision)),
    )
    .innerJoin(
      skillVersions,
      and(eq(skillVersions.skillId, skills.id), eq(skillVersions.revision, styleProfiles.revision)),
    )
    .where(
      and(
        eq(styleProfiles.userId, userId),
        eq(skills.userId, userId),
        eq(styleProfiles.status, 'accepted'),
        eq(skills.enabled, true),
      ),
    )
    .orderBy(desc(styleProfiles.createdAt))
    .limit(1);
  return row
    ? {
        id: row.profile.id,
        revision: row.version.revision,
        hash: row.version.sha256,
        text: secretRedactor.redactText(row.version.markdown).slice(0, 10000),
        privateOnly: row.profile.privateOnly || row.version.privateOnly,
      }
    : null;
}
export function citedReferences(candidate: unknown) {
  const text = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
  return [
    ...new Set([
      ...Array.from(text.matchAll(/https?:\/\/[^\s<>"\\\]]+/g), (match) =>
        match[0].replace(/[),.;]+$/, ''),
      ),
      ...Array.from(
        text.matchAll(/\[kb:(chk_[0-9A-HJKMNP-TV-Z]{26})\]/g),
        (match) => `kb:${match[1]}`,
      ),
      ...Array.from(text.matchAll(/art_[0-9A-HJKMNP-TV-Z]{26}/g), (match) => match[0]),
    ]),
  ];
}
const checkpointPrivacy = (value: unknown) =>
  z.object({ loop: z.object({ privateOnly: z.boolean() }) }).safeParse(value).data?.loop
    .privateOnly ?? true;

export async function reviewEvidence(options: {
  database: Database;
  context: ReviewContext;
  candidate: unknown;
  settings: SettingsDocument;
  signal: AbortSignal;
  network?: SafeNetworkDependencies;
}) {
  const { database: db, context, settings, signal } = options;
  const owner = context.project.userId;
  const assignment = context.run.assignment
    ? taskAssignmentSchema.parse(context.run.assignment)
    : null;
  const completed = await db.orm
    .select({ id: runs.id, key: missionTasks.taskKey })
    .from(runs)
    .innerJoin(missionTasks, eq(missionTasks.runId, runs.id))
    .where(and(eq(runs.missionId, context.mission.id), eq(runs.status, 'completed')));
  const permittedRuns = [
    context.run.id,
    ...completed
      .filter((row) => !assignment || assignment.task.depends_on.includes(row.key))
      .map((row) => row.id),
  ];
  async function permitted(tool: string, args: unknown, external: boolean) {
    const granted = await agentActionPermission(
      db,
      owner,
      context.run.id,
      'auditor',
      tool,
      args,
      'read',
      settings.connectors.value.accounts,
    );
    const counts = await db.pool.query<{ hour: number; run: number }>(
      "SELECT count(*) FILTER (WHERE created_at>now()-interval '1 hour')::int AS hour, count(*) FILTER (WHERE target LIKE $1)::int AS run FROM audit_log WHERE action='auditor.evidence.allow' AND target LIKE $2",
      [`${context.run.id}:${tool}:%`, `%:${tool}:%`],
    );
    const policy = evaluatePolicy({
      tool,
      args,
      effect: 'read',
      scope: external ? 'external' : 'internal',
      agentId: 'auditor',
      projectId: context.project.id,
      tainted: true,
      preset: settings.security.value.preset,
      rules: settings.security.value.rules,
      usage: Object.fromEntries(
        settings.security.value.rules.map((rule) => [
          rule.id,
          counts.rows[0] ?? { hour: 0, run: 0 },
        ]),
      ),
    });
    const allow = granted && policy.action === 'allow' && !signal.aborted;
    await db.orm.insert(auditLog).values({
      id: workKey('aud'),
      actorId: `Auditor (on behalf of ${owner})`,
      action: `auditor.evidence.${allow ? 'allow' : 'deny'}`,
      target: `${context.run.id}:${tool}:${valueHash(args)}`,
    });
    return allow;
  }
  const evidence: ReviewEvidence[] = [];
  // Only confirmed tool receipts; never step prompts, assistant history, or producer reasoning.
  if (await permitted('artifact.read', { runId: context.run.id }, false)) {
    const receipts = await db.orm
      .select({ call: toolCalls, checkpoint: runs.checkpoint })
      .from(toolCalls)
      .innerJoin(runs, eq(runs.id, toolCalls.runId))
      .where(and(inArray(toolCalls.runId, permittedRuns), eq(toolCalls.status, 'done')))
      .orderBy(desc(toolCalls.updatedAt))
      .limit(12);
    for (const { call, checkpoint } of receipts)
      evidence.push({
        reference: call.id,
        kind: 'receipt',
        resolved: true,
        text: secretRedactor
          .redactText(JSON.stringify({ tool: call.toolName, result: call.result }))
          .slice(0, 6000),
        privateOnly: checkpointPrivacy(checkpoint),
      });
  }
  const references = citedReferences(options.candidate);
  for (const reference of references.slice(0, 10)) {
    let entry: ReviewEvidence = {
      reference,
      kind: reference.startsWith('http')
        ? 'http'
        : reference.startsWith('kb:')
          ? 'knowledge'
          : 'artifact',
      resolved: false,
      text: 'Citation unavailable or not permitted.',
      privateOnly: false,
    };
    if (reference.startsWith('http') && (await permitted('web.fetch', { url: reference }, true))) {
      try {
        const page = await fetchPublicText(reference, signal, {
          ...options.network,
          maxResponseBytes: 65536,
          timeoutMs: 5000,
        });
        entry = {
          ...entry,
          resolved: page.status >= 200 && page.status < 300,
          text: secretRedactor.redactText(page.text).slice(0, 6000),
        };
      } catch {
        db.logger.info(
          { code: 'REVIEW_CITATION_UNAVAILABLE', runId: context.run.id },
          'An Auditor citation could not be resolved.',
        );
      }
    } else if (
      reference.startsWith('kb:') &&
      (await permitted('kb.read', { id: reference.slice(3) }, false))
    ) {
      const [chunk] = await db.orm
        .select({ text: kbChunks.text })
        .from(kbChunks)
        .innerJoin(kbSources, eq(kbSources.id, kbChunks.sourceId))
        .where(
          and(
            eq(kbChunks.id, reference.slice(3)),
            eq(kbChunks.projectId, context.project.id),
            eq(kbSources.userId, owner),
            eq(kbSources.status, 'ready'),
          ),
        );
      if (chunk)
        entry = {
          ...entry,
          resolved: true,
          text: secretRedactor.redactText(chunk.text).slice(0, 6000),
          privateOnly: context.project.privacy === 'private',
        };
    } else if (
      reference.startsWith('art_') &&
      (await permitted('artifact.read', { id: reference }, false))
    ) {
      const [artifact] = await db.orm
        .select({ value: artifacts, checkpoint: runs.checkpoint })
        .from(artifacts)
        .innerJoin(runs, eq(runs.id, artifacts.runId))
        .where(and(eq(artifacts.id, reference), inArray(artifacts.runId, permittedRuns)));
      if (artifact)
        entry = {
          ...entry,
          resolved: true,
          text: secretRedactor.redactText(artifact.value.content).slice(0, 6000),
          privateOnly: checkpointPrivacy(artifact.checkpoint),
        };
    }
    evidence.push(entry);
  }
  if (references.length > 10)
    evidence.push({
      reference: 'additional-citations',
      kind: 'http',
      resolved: false,
      text: 'Review supports at most ten distinct citations per candidate. Reduce or split the candidate.',
      privateOnly: false,
    });
  return z.array(reviewEvidenceSchema).max(32).parse(evidence);
}
