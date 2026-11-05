import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { SettingsDocument } from '@sazuz/config/settings';
import { telemetryStatusSchema } from '@sazuz/core/observability';
import {
  auditLog,
  costLedger,
  getControl,
  ownedLedger,
  projects,
  readSettings,
  settings,
  telemetryExports,
  workKey,
  type Database,
} from '@sazuz/db';
import { evaluatePolicy } from '@sazuz/policy';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const ledgerMetadataSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  runId: z.string().nullable(),
  agentId: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  costUsd: z.number().finite().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  latencyMs: z.number().finite().nonnegative(),
  estimated: z.boolean(),
  status: z.string(),
  createdAt: z.date(),
});

/** OTLP JSON contains only hashed identifiers, fixed labels, numbers and booleans. */
export function ledgerSpans(input: unknown) {
  const rows = z.array(ledgerMetadataSchema).max(50).parse(input);
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sazuz' } }] },
        scopeSpans: [
          {
            scope: { name: 'sazuz.ledger', version: '1' },
            spans: rows.map((row) => ({
              traceId: digest(row.runId ?? row.id).slice(0, 32),
              spanId: digest(row.id).slice(0, 16),
              name: 'model.call',
              kind: 3,
              startTimeUnixNano: (
                BigInt(Math.max(0, row.createdAt.getTime() - Math.ceil(row.latencyMs))) * 1_000_000n
              ).toString(),
              endTimeUnixNano: (BigInt(row.createdAt.getTime()) * 1_000_000n).toString(),
              attributes: [
                ...Object.entries({
                  call: row.id,
                  run: row.runId,
                  project: row.projectId,
                  agent: row.agentId,
                  provider: row.providerId,
                  model: row.providerId + ':' + row.modelId,
                })
                  .filter(([, value]) => value !== null)
                  .map(([key, value]) => ({
                    key: `sazuz.${key}.key`,
                    value: { stringValue: digest(value!).slice(0, 32) },
                  })),
                ...Object.entries({
                  input_tokens: row.inputTokens,
                  output_tokens: row.outputTokens,
                  cached_input_tokens: row.cachedInputTokens,
                  cost_usd: row.costUsd,
                  latency_ms: row.latencyMs,
                }).map(([key, value]) => ({ key: `sazuz.${key}`, value: { doubleValue: value } })),
                { key: 'sazuz.usage_estimated', value: { boolValue: row.estimated } },
              ],
              status: { code: row.status === 'completed' ? 1 : 2 },
            })),
          },
        ],
      },
    ],
  };
}

export async function telemetryStatus(db: Database, userId: string, document: SettingsDocument) {
  const rows = await db.orm
    .select()
    .from(telemetryExports)
    .where(eq(telemetryExports.userId, userId))
    .orderBy(desc(telemetryExports.createdAt))
    .limit(20);
  const totals = await db.orm
    .select({ status: telemetryExports.status, count: sql<number>`count(*)::int` })
    .from(telemetryExports)
    .where(eq(telemetryExports.userId, userId))
    .groupBy(telemetryExports.status);
  return telemetryStatusSchema.parse({
    enabled: document.advanced.value.telemetry,
    configured: !!document.advanced.value.telemetryEndpoint,
    settingsVersion: document.advanced.version,
    counts: {
      intent: 0,
      done: 0,
      failed: 0,
      uncertain: 0,
      blocked: 0,
      ...Object.fromEntries(totals.map((row) => [row.status, row.count])),
    },
    latest: rows.map((row) => ({
      id: row.id,
      status: row.status,
      code: row.code,
      createdAt: row.createdAt.toISOString(),
    })),
  });
}

export interface TelemetryOptions {
  database: Database;
  userId: string;
  getSettings(): SettingsDocument;
  withSecret<T>(reference: string, consume: (value: string) => Promise<T>): Promise<T>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** Each ledger row gets at most one attempt. No failed or uncertain delivery is retried. */
export async function exportTelemetry(options: TelemetryOptions, now = new Date()) {
  const { database: db, userId } = options;
  await db.orm
    .update(telemetryExports)
    .set({ status: 'uncertain', code: 'delivery_unknown', updatedAt: now })
    .where(
      and(
        eq(telemetryExports.userId, userId),
        eq(telemetryExports.status, 'intent'),
        lt(telemetryExports.createdAt, new Date(now.getTime() - 60_000)),
      ),
    );
  const document = options.getSettings();
  const configured = document.advanced;
  const endpoint = configured.value.telemetryEndpoint;
  if (!configured.value.telemetry || !endpoint) return 0;
  const [revision] = await db.orm
    .select()
    .from(settings)
    .where(and(eq(settings.namespace, 'advanced'), eq(settings.version, configured.version)));
  if (!revision) return 0;
  const c = alias(costLedger, 'c');
  const p = alias(projects, 'p');
  const candidates = await db.orm
    .select({ ledger: c })
    .from(c)
    .leftJoin(p, eq(p.id, c.projectId))
    .where(
      and(
        ownedLedger(userId),
        gte(c.createdAt, revision.updatedAt),
        lte(c.createdAt, now),
        sql`NOT EXISTS (SELECT 1 FROM telemetry_exports e WHERE e.ledger_id = c.id)`,
      ),
    )
    .orderBy(asc(c.createdAt), asc(c.id))
    .limit(50);
  if (!candidates.length) return 0;
  const inserted = await db.orm
    .insert(telemetryExports)
    .values(
      candidates.map(({ ledger }) => ({
        id: workKey('tel'),
        userId,
        ledgerId: ledger.id,
        settingsVersion: configured.version,
        status: 'intent',
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) return 0;
  const ids = inserted.map((row) => row.id);
  const accepted = new Set(inserted.map((row) => row.ledgerId));
  const body = JSON.stringify(
    ledgerSpans(
      candidates.filter(({ ledger }) => accepted.has(ledger.id)).map(({ ledger }) => ledger),
    ),
  );
  const finish = (status: string, code: string | null) =>
    db.orm
      .update(telemetryExports)
      .set({ status, code, updatedAt: new Date() })
      .where(inArray(telemetryExports.id, ids));
  const current = await db.orm
    .select({ version: settings.version })
    .from(settings)
    .where(eq(settings.namespace, 'advanced'));
  if (current[0]?.version !== configured.version || options.signal?.aborted) {
    await finish('blocked', 'configuration_changed');
    return inserted.length;
  }
  let dispatched = false;
  let blockedCode: 'configuration_changed' | 'policy_blocked' | null = null;
  const send = async (bearer?: string) => {
    const latest = await readSettings(db);
    if (latest.advanced.version !== configured.version || options.signal?.aborted) {
      blockedCode = 'configuration_changed';
      return false;
    }
    // Enabling this exact collector is the owner's standing grant; current policy can narrow it.
    const decision = evaluatePolicy({
      tool: 'observability.export',
      effect: 'send',
      scope: 'external',
      connector: 'telemetry',
      agentId: 'observability',
      projectId: 'workspace',
      preset: 'autonomous',
      knownRecipient: true,
      tainted: false,
      args: { settingsVersion: configured.version },
      rules: latest.security.value.rules,
      paused: (await getControl(db)).paused,
    });
    await db.orm.insert(auditLog).values({
      id: workKey('aud'),
      actorId: userId,
      action: `policy.${decision.action}`,
      target: `observability:${ids[0]}`,
    });
    if (decision.action !== 'allow') {
      blockedCode = 'policy_blocked';
      return false;
    }
    if (bearer !== undefined && (!bearer.length || /[\r\n\0]/.test(bearer)))
      throw new Error('Invalid collector credential.');
    dispatched = true;
    const response = await (options.fetch ?? fetch)(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
      },
      body,
      redirect: 'error',
      signal: AbortSignal.any([
        AbortSignal.timeout(5000),
        ...(options.signal ? [options.signal] : []),
      ]),
    });
    await response.body?.cancel();
    return response.ok;
  };
  try {
    const ok = configured.value.telemetrySecretRef
      ? await options.withSecret(configured.value.telemetrySecretRef, send)
      : await send();
    await finish(
      blockedCode ? 'blocked' : ok ? 'done' : 'failed',
      blockedCode ?? (ok ? null : 'collector_rejected'),
    );
  } catch {
    await finish(
      dispatched ? 'uncertain' : 'failed',
      dispatched ? 'delivery_unknown' : 'credential_unavailable',
    );
  }
  return inserted.length;
}
