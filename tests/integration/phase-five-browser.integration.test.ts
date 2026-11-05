import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  browserActions,
  browserProfiles,
  browserSessions,
  getMission,
  recordHeartbeat,
  runs,
  secrets,
  toolCalls,
  workKey,
  createMission,
} from '@sazuz/db';
import { type BrowserObservation } from '@sazuz/core/browser';
import { browserRpcResultSchema, browserWorkerRequestSchema } from '@sazuz/browser/protocol';
import { createBrowserTools } from '@sazuz/browser';
import { ToolRegistry } from '../../packages/tools/src/registry.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { decideApproval } from '../../packages/runtime/src/durable-store.js';
import { durableCheckpointSchema } from '../../packages/runtime/src/durable-contracts.js';
import { browserCanary, browserFixture } from './phase-five-fixture.js';

function ref(value: BrowserObservation, name: string) {
  const element = value.elements.find((item) => item.name.includes(name));
  if (!element) throw new Error(`Expected fixture element ${name}.`);
  return element.ref;
}
describe('Phase 5 actual Chromium through authenticated egress, vault and browser APIs', () => {
  let fixture: Awaited<ReturnType<typeof browserFixture>>;
  beforeAll(async () => {
    fixture = await browserFixture();
  });
  afterAll(async () => {
    await fixture?.close();
  });
  afterEach(async () => {
    // Direct gateway fixtures publish synthetic claims; they must release admission between cases.
    await fixture.db.orm
      .update(runs)
      .set({ status: 'cancelled', claimKey: null, workerId: null, claimedAt: null })
      .where(eq(runs.claimKey, fixture.claimKey));
  });
  it('requires authentication and an owned project for profile APIs and rejects cross-origin changes', async () => {
    expect(
      (await fixture.request('GET', '/api/browser/profiles', undefined, false)).statusCode,
    ).toBe(401);
    const value = {
      projectId: fixture.projectId,
      agentId: 'operator',
      name: 'Owner site',
      site: 'https://fixture.example',
    };
    expect(
      (await fixture.request('POST', '/api/browser/profiles', value, true, 'https://evil.example'))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await fixture.request('POST', '/api/browser/profiles', {
          ...value,
          projectId: workKey('prj'),
        })
      ).statusCode,
    ).toBe(403);
    expect((await fixture.request('POST', '/api/browser/profiles', value)).statusCode).toBe(200);
  });
  it('uses actual page observations, rejects stale refs and scopes tabs, uploads and navigation', async () => {
    const run = await fixture.mission();
    const opened = await run.act({ operation: 'open', args: { profileId: run.profile.id } }),
      id = opened.observation.sessionId;
    expect(opened.observation.tabs, 'Initial browser tabs').toHaveLength(1);
    const viewed = await run.act({
      operation: 'navigate',
      args: { sessionId: id, url: 'https://fixture.example/fields' },
    });
    expect(viewed.observation.text).toContain('Access form');
    expect(fixture.requests).toBeGreaterThan(0);
    const fresh = await run.act({ operation: 'read', args: { sessionId: id } });
    const stale = await run.act({
      operation: 'click',
      args: { sessionId: id, ref: ref(viewed.observation, 'Echo code') },
    });
    expect(stale.observation.reason).toContain('stale');
    const download = await run.act({
      operation: 'download',
      args: { sessionId: id, ref: ref(stale.observation, 'Download data') },
    });
    expect(download.observation.file).toMatchObject({
      name: 'download.csv',
      scan: 'restricted-text',
    });
    expect(download.observation.tabs, JSON.stringify(download.observation.tabs)).toHaveLength(1);
    await run.act({
      operation: 'upload',
      args: {
        sessionId: id,
        ref: ref(download.observation, 'Upload file'),
        fileHandle: download.observation.file!.handle,
      },
    });
    const tab = await run.act({ operation: 'tabs', args: { sessionId: id, action: 'new' } });
    expect(tab.observation.tabs, JSON.stringify(tab.observation.tabs)).toHaveLength(2);
    expect(fresh.observation.revision).toBeGreaterThan(viewed.observation.revision);
    const forged = await run.prepare({
      operation: 'navigate',
      args: { sessionId: id, url: 'https://other.example/' },
    });
    await expect(fixture.gateway.execute(forged)).rejects.toThrow();
    await fixture.client({ mode: 'close', sessionId: id });
  });
  it('keeps a typed canary out of observations, receipts, APIs and logs and restores only encrypted state', async () => {
    const run = await fixture.mission('Canary site');
    const secret = await fixture.runtime.vault.create({
      name: 'Form access code',
      value: browserCanary,
      createdBy: fixture.userId,
    });
    const profile = await fixture.gateway.profiles.update(fixture.userId, run.profile.id, {
      name: 'Canary site',
      secretRefs: [secret.reference],
      expiresAt: null,
      version: run.profile.version,
    });
    const opened = await run.act({ operation: 'open', args: { profileId: profile.id } }),
      id = opened.observation.sessionId;
    let page = (
      await run.act({
        operation: 'navigate',
        args: { sessionId: id, url: 'https://fixture.example/fields' },
      })
    ).observation;
    page = (
      await run.act({
        operation: 'type',
        args: { sessionId: id, ref: ref(page, 'Access code'), value: { secret: secret.reference } },
      })
    ).observation;
    expect(page.sensitive).toBe(true);
    expect(page.screenshot).toBe('withheld');
    page = (
      await run.act({ operation: 'click', args: { sessionId: id, ref: ref(page, 'Echo code') } })
    ).observation;
    expect(page.text).toContain('[REDACTED]');
    expect(JSON.stringify(page)).not.toContain(browserCanary);
    const screenshot = await run.act({ operation: 'screenshot', args: { sessionId: id } });
    expect(screenshot.observation.imageHandle).toBeUndefined();
    const rows = await fixture.db.orm.select().from(secrets);
    expect(rows.some((row) => row.purpose === 'browser-profiles')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(browserCanary);
    for (const path of ['browser/profiles', 'browser/sessions', 'vault/secrets'])
      expect((await fixture.request('GET', `/api/${path}`)).body).not.toContain(browserCanary);
    expect(JSON.stringify(await fixture.db.orm.select().from(browserActions))).not.toContain(
      browserCanary,
    );
    expect(JSON.stringify(await fixture.db.orm.select().from(toolCalls))).not.toContain(
      browserCanary,
    );
    expect(fixture.logLines.join('')).not.toContain(browserCanary);
    await run.act({ operation: 'close', args: { sessionId: id } });
    const restored = await fixture.mission('Canary site', profile);
    const result = await restored.act({ operation: 'open', args: { profileId: profile.id } });
    expect(result.observation.sensitive).toBe(true);
    await restored.act({
      operation: 'navigate',
      args: { sessionId: result.observation.sessionId, url: 'https://fixture.example/fields' },
    });
    const actual = fixture.service.engine.sessions.get(result.observation.sessionId)!;
    expect(
      await actual.context.pages()[0]!.evaluate(() => localStorage.getItem('saved-code')),
    ).toBe(browserCanary);
    const wiped = await fixture.gateway.profiles.revoke(
      fixture.userId,
      profile.id,
      profile.version,
      true,
    );
    expect(wiped.hasSavedState).toBe(false);
    expect(wiped.retired).toBe(true);
    await expect(fixture.service.engine.valid(result.observation.sessionId)).rejects.toThrow();
    const [record] = await fixture.db.orm
      .select()
      .from(browserProfiles)
      .where(eq(browserProfiles.id, profile.id));
    expect(record?.vaultRef).toBeNull();
  });
  it('replays a completed submit once and reports an interrupted receipt as uncertain', async () => {
    const run = await fixture.mission('Receipt site'),
      opened = await run.act({ operation: 'open', args: { profileId: run.profile.id } }),
      id = opened.observation.sessionId;
    const view = await run.act({
        operation: 'navigate',
        args: { sessionId: id, url: 'https://fixture.example/review' },
      }),
      before = fixture.submissions;
    const submitted = await run.act({
      operation: 'click',
      args: { sessionId: id, ref: ref(view.observation, 'Submit project') },
    });
    expect(submitted.observation.text).toContain('Project submitted');
    expect(fixture.submissions - before).toBe(1);
    const retry = { ...submitted.message, nonce: randomUUID(), expiresAt: Date.now() + 45000 };
    await run.send(retry);
    expect(fixture.submissions - before).toBe(1);
    await fixture.db.orm
      .update(browserActions)
      .set({ status: 'started', result: null })
      .where(eq(browserActions.key, retry.callKey));
    const verified = await fixture.gateway.execute({ ...retry, verify: true });
    expect(verified.status).toBe('unknown');
    expect(fixture.submissions - before).toBe(1);
    await fixture.client({ mode: 'close', sessionId: id });
  });
  it('denies forged claims, cross-run sessions and ungranted credentials before any site action', async () => {
    const run = await fixture.mission('Scoped site');
    const opened = await run.act({ operation: 'open', args: { profileId: run.profile.id } }),
      id = opened.observation.sessionId;
    const message = await run.prepare({ operation: 'read', args: { sessionId: id } });
    await expect(fixture.gateway.execute({ ...message, claimKey: randomUUID() })).rejects.toThrow();
    const other = await fixture.mission('Other site'),
      wrong = await other.prepare({ operation: 'read', args: { sessionId: id } });
    await expect(fixture.gateway.execute(wrong)).rejects.toThrow();
    const page = await run.act({
      operation: 'navigate',
      args: { sessionId: id, url: 'https://fixture.example/fields' },
    });
    const value = await run.prepare({
      operation: 'type',
      args: {
        sessionId: id,
        ref: ref(page.observation, 'Access code'),
        value: { secret: `secret://${workKey('sec')}` },
      },
    });
    await expect(fixture.gateway.execute(value)).rejects.toThrow();
    await fixture.client({ mode: 'close', sessionId: id });
  });
  it('pauses a real durable Operator after login detection and retains the completed navigation intent', async () => {
    const profile = await fixture.gateway.profiles.create(fixture.userId, {
      projectId: fixture.projectId,
      agentId: 'operator',
      name: 'Login site',
      site: 'https://fixture.example',
    });
    const run = await createMission(
      fixture.db,
      fixture.userId,
      {
        projectId: fixture.projectId,
        agent: 'operator',
        goal: `Open profile ${profile.id} and sign in.`,
        requestId: randomUUID(),
      },
      { maxSteps: 20, maxCostUsd: 1, maxWallTimeSeconds: 600 },
    );
    const tools = new ToolRegistry(
      createBrowserTools({
        async request(ctx, operation, args, verify) {
          await recordHeartbeat(fixture.db, fixture.workerId);
          const message = browserWorkerRequestSchema.parse({
            workerId: fixture.workerId,
            claimKey: ctx.claimKey,
            runId: ctx.runId,
            callKey: ctx.idempotencyKey,
            command: { operation, args },
            verify,
            nonce: randomUUID(),
            expiresAt: Date.now() + 45000,
          });
          return browserRpcResultSchema.parse(await fixture.gateway.execute(message));
        },
      }),
    );
    let calls = 0;
    const prompts: unknown[] = [];
    const execute = createDurableExecutor({
      database: fixture.db,
      workerId: fixture.workerId,
      dataDir: fixture.directory,
      getSettings: () => fixture.runtime.settings,
      tools,
      router: () => ({
        generate: async (request) => {
          prompts.push(request.messages);
          calls++;
          const [active] = await fixture.db.orm
            .select()
            .from(browserSessions)
            .where(
              and(eq(browserSessions.runId, run.run.id), eq(browserSessions.status, 'active')),
            );
          return {
            text: 'Use the authorized site.',
            toolCalls: [
              {
                id: `generated-${calls}`,
                name: active ? 'browser.navigate' : 'browser.open',
                args: active
                  ? { sessionId: active.id, url: 'https://fixture.example/login' }
                  : { profileId: profile.id },
              },
            ],
            finishReason: 'tool-calls',
            providerId: 'fixture',
            modelId: 'fixture',
            costUsd: 0,
            costEstimated: false,
            latencyMs: 1,
            usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, source: 'provider' },
          };
        },
        generateObject: () => Promise.reject(new Error('Operator does not plan.')),
      }),
    });
    for (let iteration = 0; iteration < 4; iteration++) {
      await execute.execute(run.run.id);
      const detail = (await getMission(fixture.db, fixture.userId, run.id))!;
      if (detail.mission.run.status === 'paused') break;
      const pending = detail.approvals.find((item) => item.status === 'pending');
      expect(pending).toBeDefined();
      await decideApproval(
        fixture.db,
        fixture.userId,
        pending!.id,
        { action: 'approve', version: pending!.version, note: '' },
        tools,
        () => fixture.runtime.settings,
      );
    }
    const detail = (await getMission(fixture.db, fixture.userId, run.id))!;
    expect(detail.mission.run.status).toBe('paused');
    expect(detail.mission.run.tainted).toBe(true);
    expect(calls).toBe(2);
    const [row] = await fixture.db.orm.select().from(runs).where(eq(runs.id, run.run.id));
    const checkpoint = durableCheckpointSchema.parse(row!.checkpoint);
    expect(checkpoint.loop.nextCall).toBe(1);
    expect(
      detail.steps.some(
        (step) => step.toolName === 'browser.navigate' && step.content.includes('human_required'),
      ),
    ).toBe(true);
    const [active] = await fixture.db.orm
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.runId, run.run.id));
    expect(active?.control).toBe('human');
    expect(JSON.stringify(prompts)).not.toContain(browserCanary);
    expect(JSON.stringify(detail)).not.toContain(browserCanary);
    await execute.execute(run.run.id);
    expect(calls).toBe(2);
  });
});
