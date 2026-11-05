import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { memorySchema } from '@sazuz/core/memory';
import {
  createMission,
  knowledgeJobs,
  modelCatalog,
  recordHeartbeat,
  saveSetting,
  workKey,
} from '@sazuz/db';
import { consumeExecutionSecret, makeExecutionRequest, secretRedactor } from '@sazuz/vault';
import { phaseFourFixture } from './phase-four-fixture.js';

describe('Phase 4 authenticated HTTP and scoped worker credentials', () => {
  let fixture: Awaited<ReturnType<typeof phaseFourFixture>>;
  beforeAll(async () => {
    fixture = await phaseFourFixture();
  });
  afterAll(async () => {
    await fixture?.close();
  });
  it('requires login and same-origin mutation, validates scope and round-trips create/review/delete', async () => {
    const { request, projectId } = fixture;
    expect((await request('GET', '/api/memory', undefined, false)).statusCode).toBe(401);
    const body = {
      scope: 'project',
      projectId,
      kind: 'preference',
      content: 'Prefers concise reports.',
    };
    expect(
      (await request('POST', '/api/memory', body, true, 'https://attacker.test')).statusCode,
    ).toBe(403);
    expect((await request('POST', '/api/memory', { ...body, scope: 'global' })).statusCode).toBe(
      400,
    );
    const created = await request('POST', '/api/memory', body);
    expect(created.statusCode).toBe(200);
    const memory = memorySchema.parse(created.json());
    expect((await request('POST', '/api/memory/search', { projectId })).body).toContain(
      memory.content,
    );
    const edited = await request('PUT', `/api/memory/${memory.id}`, {
      version: memory.version,
      content: 'Prefers bullet reports.',
      importance: 0.7,
      status: 'accepted',
    });
    expect(edited.statusCode).toBe(200);
    expect(
      (await request('DELETE', `/api/memory/${memory.id}`, { version: memory.version })).statusCode,
    ).toBe(409);
    expect(
      (await request('DELETE', `/api/memory/${memory.id}`, { version: memory.version + 1 }))
        .statusCode,
    ).toBe(200);
    expect((await request('POST', '/api/memory/search', { projectId })).json()).toEqual([]);
    expect(
      (await request('POST', '/api/memory/search', { projectId: workKey('prj') })).statusCode,
    ).toBe(404);
    expect((await request('GET', '/api/memory/jobs')).statusCode).toBe(200);
  });
  it('excludes secret canaries from errors, returned memory and logs', async () => {
    const canary = 'phase4-memory-canary-59730281';
    secretRedactor.register(canary);
    const result = await fixture.request('POST', '/api/memory', {
      scope: 'global',
      kind: 'fact',
      content: canary,
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).not.toContain(canary);
    expect((await fixture.request('GET', '/api/memory')).body).not.toContain(canary);
    expect(fixture.logLines.join('')).not.toContain(canary);
  });
  it('binds knowledge capsules to the live job, claim and configured provider; refuses replay and unrelated secrets', async () => {
    const { db, runtime, app, userId, projectId } = fixture;
    const canary = 'phase4-capsule-canary-89712043';
    const providerSecret = await runtime.vault.create({
      name: 'Embedding fixture key',
      value: canary,
      createdBy: userId,
    });
    const otherSecret = await runtime.vault.create({
      name: 'Unrelated fixture key',
      value: 'phase4-unrelated-5917823',
      createdBy: userId,
    });
    const providerRef = providerSecret.reference;
    const current = runtime.settings.providers;
    await saveSetting(db, {
      namespace: 'providers',
      actorId: userId,
      expectedVersion: current.version,
      value: {
        items: [
          {
            id: 'fixture',
            name: 'Fixture',
            kind: 'openai-compatible',
            baseUrl: 'https://model.example.test/v1',
            secretRef: providerRef,
            locality: 'cloud',
            enabled: true,
          },
        ],
      },
    });
    await vi.waitFor(() => expect(runtime.settings.providers.version).toBe(current.version + 1));
    await db.orm.insert(modelCatalog).values({ providerId: 'fixture', modelId: 'fast', value: {} });
    const mission = await createMission(
      db,
      userId,
      { projectId, agent: 'researcher', goal: 'A fixture', requestId: randomUUID() },
      { maxSteps: 10, maxCostUsd: 1, maxWallTimeSeconds: 60 },
    );
    const workerId = workKey('wrk'),
      claimKey = randomUUID(),
      id = workKey('job');
    await recordHeartbeat(db, workerId);
    await db.orm.insert(knowledgeJobs).values({
      id,
      userId,
      projectId,
      runId: mission.run.id,
      eventKey: id,
      kind: 'extract',
      payload: { kind: 'extract', runId: mission.run.id },
      status: 'running',
      workerId,
      claimKey,
      maxCostUsd: 0.1,
    });
    const identity = {
      workspaceId: (await runtime.state()).workspaceId,
      workerId,
      runId: null,
      scope: 'knowledge' as const,
      executionId: id,
      claimKey,
      reference: providerRef,
    };
    const sign = (overrides: Partial<typeof identity> = {}) =>
      makeExecutionRequest(runtime.plumbing.operatorKey, { ...identity, ...overrides });
    const send = (signed: ReturnType<typeof sign>) =>
      app.inject({
        method: 'POST',
        url: '/internal/execution',
        headers: { 'x-sazuz-worker-signature': signed.signature },
        payload: signed.request,
      });
    const signed = sign();
    const response = await send(signed);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(canary);
    expect(
      await consumeExecutionSecret(
        runtime.plumbing.operatorKey,
        signed.request,
        response.json(),
        (value) => Promise.resolve(value === canary),
      ),
    ).toBe(true);
    expect((await send(signed)).statusCode).toBe(409);
    expect((await send(sign({ claimKey: randomUUID() }))).statusCode).toBe(403);
    expect((await send(sign({ reference: otherSecret.reference }))).statusCode).toBe(403);
    await db.orm.update(knowledgeJobs).set({ status: 'completed' }).where(eq(knowledgeJobs.id, id));
    expect((await send(sign())).statusCode).toBe(403);
    expect(fixture.logLines.join('')).not.toContain(canary);
  });
});
