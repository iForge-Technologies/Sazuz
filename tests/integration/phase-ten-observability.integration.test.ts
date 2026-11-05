import { createServer, type Server } from 'node:http';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshSettings, type SettingsValues } from '@sazuz/config/settings';
import { costDashboardSchema, telemetryStatusSchema } from '@sazuz/core/observability';
import {
  collectCostAlerts,
  costAlerts,
  costDashboard,
  costLedger,
  createProject,
  notifications,
  projects,
  readSettings,
  remainingSpend,
  saveSetting,
  settingsHistory,
  telemetryExports,
  users,
  workKey,
} from '@sazuz/db';
import {
  createNotificationRouter,
  exportTelemetry,
  telemetryStatus,
} from '../../packages/runtime/src/index.js';
import { phaseFourFixture } from './phase-four-fixture.js';
import { registerPhaseTen } from '../../apps/server/src/phase-ten.js';

describe('Phase 10 costs, threshold delivery and optional metadata export', () => {
  let f: Awaited<ReturnType<typeof phaseFourFixture>>;
  let server: Server;
  let endpoint: string;
  let credential: string;
  const canary = 'phase-ten-private-collector-canary-71024';
  let collectorStatus = 200;
  const received: { body: string; authorized: boolean; path: string }[] = [];
  const now = new Date('2026-11-05T12:00:00Z');
  async function advanced(value: Partial<SettingsValues['advanced']>) {
    const before = (await readSettings(f.db)).advanced;
    const result = await saveSetting(f.db, {
      namespace: 'advanced',
      actorId: f.userId,
      expectedVersion: before.version,
      value: { ...before.value, ...value },
    });
    await vi.waitFor(() => expect(f.runtime.settings.advanced.version).toBe(result.version));
    return result;
  }
  const row = (value: Partial<typeof costLedger.$inferInsert> = {}) => ({
    id: workKey('cost'),
    projectId: f.projectId,
    agentId: 'writer',
    providerId: 'fixture',
    modelId: 'small',
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 0,
    costUsd: 1,
    estimated: false,
    latencyMs: 10,
    status: 'completed',
    createdAt: new Date(),
    ...value,
  });
  const exporter = () => ({
    database: f.db,
    userId: f.userId,
    getSettings: () => f.runtime.settings,
    withSecret: <T>(reference: string, consume: (value: string) => Promise<T>) =>
      f.runtime.vault.withSecret(reference as `secret://sec_${string}`, 'user', consume),
  });
  beforeAll(async () => {
    f = await phaseFourFixture(registerPhaseTen);
    credential = (
      await f.runtime.vault.create(
        { name: 'Phase 10 collector', value: canary, createdBy: f.userId },
        'user',
      )
    ).reference;
    server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        received.push({
          body,
          authorized: request.headers.authorization === `Bearer ${canary}`,
          path: request.url ?? '',
        });
        response
          .writeHead(collectorStatus, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ignored: canary }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Collector fixture did not bind.');
    endpoint = `http://127.0.0.1:${address.port}/v1/traces`;
  });
  beforeEach(async () => {
    await f.db.orm.delete(costLedger);
    await f.db.orm.delete(costAlerts);
    await f.db.orm.delete(notifications);
    await f.db.orm.update(projects).set({ budgetUsd: 100 }).where(eq(projects.id, f.projectId));
    received.length = 0;
    collectorStatus = 200;
    await advanced({
      telemetry: false,
      telemetryEndpoint: endpoint,
      telemetrySecretRef: credential,
    });
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    await f?.close();
  });
  it('aggregates charged failures, UTC days, models, agents and owned projects without leaking another owner', async () => {
    const foreignUser = 'phase-ten-other-owner';
    await f.db.orm
      .insert(users)
      .values({ id: foreignUser, name: 'Other owner', email: 'phase-ten-other@example.test' });
    const foreign = await createProject(f.db, foreignUser, { name: 'Private other project' });
    await f.db.orm.update(projects).set({ budgetUsd: 10 }).where(eq(projects.id, f.projectId));
    await f.db.orm.insert(costLedger).values([
      row({ costUsd: 10, createdAt: new Date('2026-11-01T00:00:00Z') }),
      row({
        costUsd: 2,
        agentId: 'researcher',
        modelId: 'large',
        status: 'failed',
        estimated: true,
        createdAt: new Date('2026-11-05T01:00:00Z'),
      }),
      row({ costUsd: 3, createdAt: new Date('2026-10-31T23:59:59Z') }),
      row({ costUsd: 0.5, projectId: null, createdAt: new Date('2026-11-05T02:00:00Z') }),
      row({ costUsd: 100, projectId: foreign.id, createdAt: now }),
      row({ costUsd: 1000, createdAt: new Date('2026-12-01T00:00:00Z') }),
    ]);
    const summary = await costDashboard(f.db, f.userId, freshSettings(), undefined, now);
    expect(summary).toMatchObject({
      costUsd: 12.5,
      allTimeUsd: 15.5,
      todayUsd: 2.5,
      calls: 3,
      failedCalls: 1,
      estimatedCalls: 1,
      inputTokens: 300,
      outputTokens: 60,
      elapsedDays: 4.5,
      daysInMonth: 30,
    });
    expect(summary.forecastUsd).toBeCloseTo((12.5 / 4.5) * 30);
    expect(summary.groups.model).toHaveLength(2);
    expect(summary.groups.agent).toHaveLength(2);
    expect(summary.groups.day.map((item) => item.key)).toEqual(['2026-11-01', '2026-11-05']);
    expect(JSON.stringify(summary)).not.toContain('Private other project');
    const scoped = await costDashboard(f.db, f.userId, freshSettings(), f.projectId, now);
    expect(scoped.thresholds).toEqual([
      { period: 'project', capUsd: 10, spentUsd: 15, percentUsed: 150, reached: [50, 80, 100] },
    ]);
    expect((await costDashboard(f.db, foreignUser, freshSettings(), undefined, now)).costUsd).toBe(
      100,
    );
    await expect(
      costDashboard(f.db, f.userId, freshSettings(), foreign.id, now),
    ).rejects.toMatchObject({ code: 'MISSION_NOT_FOUND' });
    expect((await f.request('GET', '/api/costs/dashboard', undefined, false)).statusCode).toBe(401);
    expect((await f.request('GET', '/api/costs/dashboard?unexpected=1')).statusCode).toBe(400);
    expect(
      (await f.request('GET', `/api/costs/dashboard?projectId=${foreign.id}`)).statusCode,
    ).toBe(404);
    expect(
      costDashboardSchema.safeParse((await f.request('GET', '/api/costs/dashboard')).json())
        .success,
    ).toBe(true);
  });
  it('deduplicates concurrent crossings atomically and routes alerts through Calm Mode', async () => {
    const document = freshSettings();
    document.budgets.value = {
      ...document.budgets.value,
      dailyUsd: 20,
      monthlyUsd: 40,
      alertPercentages: [50, 100],
    };
    document.profile.value.noiseBudget = 0;
    await f.db.orm
      .update(projects)
      .set({ budgetUsd: 20, privacy: 'private' })
      .where(eq(projects.id, f.projectId));
    await f.db.orm.insert(costLedger).values(row({ costUsd: 20, createdAt: now }));
    const counts = await Promise.all([
      collectCostAlerts(f.db, f.userId, document, now),
      collectCostAlerts(f.db, f.userId, document, now),
      collectCostAlerts(f.db, f.userId, document, now),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(5);
    expect(await f.db.orm.select().from(costAlerts)).toHaveLength(5);
    const alerts = await f.db.orm.select().from(notifications);
    expect(alerts).toHaveLength(5);
    expect(alerts.filter((item) => item.projectId === f.projectId)).toHaveLength(2);
    expect(alerts.every((item) => item.privateOnly)).toBe(true);
    const deliver = vi.fn(() => Promise.resolve());
    const router = createNotificationRouter({
      database: f.db,
      getSettings: () => document,
      deliver,
    });
    await router.tick(new Date('2026-11-05T23:00:00Z'));
    expect(deliver).not.toHaveBeenCalled();
    expect(
      (await f.db.orm.select().from(notifications)).every(
        (item) => item.classificationStatus === 'done',
      ),
    ).toBe(true);
    expect(await collectCostAlerts(f.db, f.userId, document, now)).toBe(0);
    const december = new Date('2026-12-01T12:00:00Z');
    await f.db.orm.insert(costLedger).values(row({ costUsd: 20, createdAt: december }));
    expect(await collectCostAlerts(f.db, f.userId, document, december)).toBe(3);
  });
  it('uses the same UTC periods for budget admission and cost views regardless of database timezone', async () => {
    await f.db.orm
      .insert(costLedger)
      .values([
        row({ costUsd: 8, createdAt: new Date('2026-11-05T01:00:00Z') }),
        row({ costUsd: 3, createdAt: new Date('2026-11-04T23:59:59Z') }),
        row({ costUsd: 100, createdAt: new Date('2026-10-31T23:59:59Z') }),
        row({ costUsd: 1000, createdAt: new Date('2026-12-01T00:00:00Z') }),
      ]);
    expect(
      await remainingSpend(f.db, { dailyUsd: 10, monthlyUsd: 20 }, f.projectId, 200, now),
    ).toBe(2);
    expect(
      await remainingSpend(f.db, { dailyUsd: 100, monthlyUsd: 12 }, f.projectId, 200, now),
    ).toBe(1);
    expect(
      await remainingSpend(f.db, { dailyUsd: 100, monthlyUsd: 200 }, f.projectId, 112, now),
    ).toBe(1);
  });
  it('does not resolve credentials or send anything while disabled, and exports only post-opt-in calls once', async () => {
    await f.db.orm.insert(costLedger).values(row({ createdAt: new Date(Date.now() - 120_000) }));
    const withSecret = vi.fn(() =>
      Promise.reject(new Error('Disabled export cannot resolve a credential.')),
    );
    expect(await exportTelemetry({ ...exporter(), withSecret })).toBe(0);
    expect(withSecret).not.toHaveBeenCalled();
    const revision = await advanced({ telemetry: true });
    const history = await f.db.orm
      .select()
      .from(settingsHistory)
      .where(
        and(
          eq(settingsHistory.namespace, 'advanced'),
          eq(settingsHistory.version, revision.version),
        ),
      );
    expect(history).toHaveLength(1);
    const start = new Date(Date.now() + 10);
    await f.db.orm
      .insert(costLedger)
      .values([
        row({ createdAt: start }),
        row({ createdAt: start, status: 'failed', costUsd: 0.1 }),
      ]);
    const counts = await Promise.all([
      exportTelemetry(exporter(), new Date(start.getTime() + 100)),
      exportTelemetry(exporter(), new Date(start.getTime() + 100)),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ authorized: true, path: '/v1/traces' });
    expect(received[0]!.body).not.toContain(canary);
    expect(received[0]!.body).not.toContain(endpoint);
    const publicStatus = telemetryStatusSchema.parse(
      (await f.request('GET', '/api/observability/status')).json(),
    );
    expect(publicStatus.counts.done).toBe(2);
    expect(JSON.stringify(publicStatus)).not.toContain(canary);
    expect(JSON.stringify(await f.db.orm.select().from(telemetryExports))).not.toContain(canary);
    await exportTelemetry(exporter(), new Date(start.getTime() + 100));
    expect(received).toHaveLength(1);
    await advanced({ telemetry: false });
    await f.db.orm.insert(costLedger).values(row());
    await exportTelemetry(exporter());
    expect(received).toHaveLength(1);
  });
  it('keeps rejected and interrupted sends bounded and never retries them', async () => {
    await advanced({ telemetry: true });
    collectorStatus = 503;
    await f.db.orm.insert(costLedger).values(row());
    await exportTelemetry(exporter());
    expect((await telemetryStatus(f.db, f.userId, f.runtime.settings)).counts.failed).toBe(1);
    await f.db.orm.insert(costLedger).values(row());
    const transport = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error(`Uncertain network response ${canary}`)),
    );
    await exportTelemetry({ ...exporter(), fetch: transport });
    await exportTelemetry({ ...exporter(), fetch: transport });
    expect(transport).toHaveBeenCalledTimes(1);
    const status = await telemetryStatus(f.db, f.userId, f.runtime.settings);
    expect(status.counts).toMatchObject({ failed: 1, uncertain: 1 });
    expect(JSON.stringify(status)).not.toContain(canary);
    const [receipt] = await f.db.orm.select().from(telemetryExports);
    await f.db.orm
      .update(telemetryExports)
      .set({ status: 'intent', code: null, createdAt: new Date(Date.now() - 61_000) })
      .where(eq(telemetryExports.id, receipt!.id));
    await exportTelemetry(exporter());
    expect((await telemetryStatus(f.db, f.userId, f.runtime.settings)).counts.uncertain).toBe(2);
    expect(received).toHaveLength(1);
  });
  it('blocks revoked collector consent and unavailable credentials before network dispatch', async () => {
    await advanced({ telemetry: true });
    await f.db.orm.insert(costLedger).values(row());
    const revoked = {
      ...exporter(),
      withSecret: async <T>(_reference: string, consume: (value: string) => Promise<T>) => {
        await advanced({ telemetry: false });
        return consume(canary);
      },
    };
    await exportTelemetry(revoked);
    expect((await telemetryStatus(f.db, f.userId, f.runtime.settings)).counts.blocked).toBe(1);
    await advanced({ telemetry: true });
    await f.db.orm.insert(costLedger).values(row());
    await exportTelemetry({
      ...exporter(),
      withSecret: () => Promise.reject(new Error('Vault locked')),
    });
    expect(
      (await telemetryStatus(f.db, f.userId, f.runtime.settings)).latest.some(
        (item) => item.code === 'credential_unavailable',
      ),
    ).toBe(true);
    expect(received).toHaveLength(0);
  });
  it('honors global policy denials and supports a collector with no credential', async () => {
    await advanced({ telemetry: true, telemetrySecretRef: null });
    const security = (await readSettings(f.db)).security;
    const rules = [
      {
        id: 'deny-observability',
        scope: { type: 'global' as const },
        match: { tool: 'observability.export' },
        when: [],
        action: 'deny' as const,
      },
    ];
    await saveSetting(f.db, {
      namespace: 'security',
      actorId: f.userId,
      expectedVersion: security.version,
      value: { ...security.value, rules },
    });
    await f.db.orm.insert(costLedger).values(row());
    await exportTelemetry(exporter());
    expect((await telemetryStatus(f.db, f.userId, f.runtime.settings)).latest[0]?.code).toBe(
      'policy_blocked',
    );
    expect(received).toHaveLength(0);
    await saveSetting(f.db, {
      namespace: 'security',
      actorId: f.userId,
      expectedVersion: security.version + 1,
      value: security.value,
    });
    await f.db.orm.insert(costLedger).values(row());
    await exportTelemetry(exporter());
    expect(received).toHaveLength(1);
    expect(received[0]?.authorized).toBe(false);
    expect((await f.request('GET', '/api/observability/status?unexpected=1')).statusCode).toBe(400);
    expect((await f.request('GET', '/api/observability/status', undefined, false)).statusCode).toBe(
      401,
    );
  });
});
