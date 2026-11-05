import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMission,
  getMission,
  jsonValue,
  sandboxExecutions,
  runs,
  toolCalls,
  workKey,
} from '@sazuz/db';
import { sandboxInputSchema } from '@sazuz/core/sandbox';
import {
  createSandboxService,
  createSandboxTools,
  type ContainerEngine,
  type ContainerInspection,
} from '@sazuz/sandbox';
import { ToolRegistry, type ToolContext } from '../../packages/tools/src/index.js';
import { secretRedactor } from '@sazuz/vault';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { decideApproval } from '../../packages/runtime/src/durable-store.js';
import { registerPhaseFive } from '../../apps/server/src/phase-five.js';
import { phaseFourFixture } from './phase-four-fixture.js';

describe('Phase 5 sandbox receipts, runtime policy and authenticated diagnostics', () => {
  let fixture: Awaited<ReturnType<typeof phaseFourFixture>>;
  const containers = new Map<string, ContainerInspection>();
  let starts = 0;
  const canary = 'sandbox-output-canary-68131942';
  const engine: ContainerEngine = {
    inspect: (name) => Promise.resolve(containers.get(name) ?? null),
    create: (name, spec) => {
      containers.set(name, {
        Name: `/${name}`,
        Config: { Labels: spec.Labels },
        State: { Running: false, ExitCode: 0, Status: 'created' },
      });
      return Promise.resolve();
    },
    start: (name) => {
      starts++;
      containers.get(name)!.State = { Running: false, ExitCode: 0, Status: 'exited' };
      return Promise.resolve();
    },
    stop: (name) => {
      containers.get(name)!.State.Running = false;
      return Promise.resolve();
    },
    logs: () => {
      const text = Buffer.from(`computed 42 ${canary}`),
        header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(text.length, 4);
      return Promise.resolve(Buffer.concat([header, text]));
    },
    remove: (name) => {
      containers.delete(name);
      return Promise.resolve();
    },
  };
  beforeAll(async () => {
    fixture = await phaseFourFixture(registerPhaseFive);
    secretRedactor.register(canary);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  const args = sandboxInputSchema.parse({ language: 'python', code: 'print(42)' });
  function service(selectedEngine = engine) {
    return createSandboxService({
      database: fixture.db,
      config: fixture.runtime.config,
      getSettings: () => fixture.runtime.settings,
      key: () => Promise.resolve(fixture.runtime.plumbing.operatorKey),
      engine: () => selectedEngine,
    });
  }
  async function mission() {
    return createMission(
      fixture.db,
      fixture.userId,
      {
        projectId: fixture.projectId,
        goal: 'Compute forty two using Python.',
        agent: 'analyst',
        requestId: randomUUID(),
      },
      { maxSteps: 10, maxCostUsd: 1, maxWallTimeSeconds: 120 },
    );
  }
  function context(runId: string): ToolContext {
    return {
      workspaceDir: fixture.directory,
      projectId: fixture.projectId,
      runId,
      agentId: 'analyst',
      idempotencyKey: `${runId}:1:0`,
      signal: new AbortController().signal,
    };
  }
  it('persists sanitized results and replays them without another container start', async () => {
    const run = await mission();
    const ctx = context(run.run.id);
    const before = starts;
    const first = await service().run(ctx, args);
    const second = await service().run(ctx, args);
    expect(first).toEqual(second);
    expect(starts - before).toBe(1);
    expect(first.output).toContain('computed 42');
    const [row] = await fixture.db.orm
      .select()
      .from(sandboxExecutions)
      .where(eq(sandboxExecutions.key, ctx.idempotencyKey));
    expect(row?.status).toBe('done');
    expect(JSON.stringify(row)).not.toContain(canary);
    expect(await service().verify(ctx, args)).toEqual({ status: 'done', result: first });
  });
  it('reconciles a completed container after a lost acknowledgement and refuses an absent started container', async () => {
    const run = await mission();
    const ctx = context(run.run.id);
    const result = await service().run(ctx, args);
    const [row] = await fixture.db.orm
      .select()
      .from(sandboxExecutions)
      .where(eq(sandboxExecutions.id, result.executionId));
    await fixture.db.orm
      .update(sandboxExecutions)
      .set({ status: 'running', result: null })
      .where(eq(sandboxExecutions.id, result.executionId));
    expect(await service().verify(ctx, args)).toEqual({ status: 'unknown' });
    containers.set(row!.containerName, {
      Name: `/${row!.containerName}`,
      Config: { Labels: {} },
      State: { Running: false, ExitCode: 0, Status: 'exited' },
    });
    const before = starts;
    expect((await service().verify(ctx, args)).status).toBe('done');
    expect(starts).toBe(before);
  });
  it('rejects cross-project, changed arguments and network requests without configured domains', async () => {
    const run = await mission();
    const ctx = context(run.run.id);
    await expect(service().run({ ...ctx, projectId: workKey('prj') }, args)).rejects.toThrow();
    await expect(service().run(ctx, { ...args, network: 'allowlist' })).rejects.toThrow();
    await service().run(ctx, args);
    await expect(service().run(ctx, { ...args, code: 'print(99)' })).rejects.toThrow();
  });
  it('redacts the original proxy capability recovered from a container after a worker restart', async () => {
    const run = await mission();
    const ctx = context(run.run.id);
    const result = await service().run(ctx, args);
    const [row] = await fixture.db.orm
      .select()
      .from(sandboxExecutions)
      .where(eq(sandboxExecutions.id, result.executionId));
    await fixture.db.orm
      .update(sandboxExecutions)
      .set({ status: 'running', result: null })
      .where(eq(sandboxExecutions.id, result.executionId));
    const oldToken = `previous-worker-capability-${randomUUID()}`;
    const encoded = Buffer.from(`sazuz:${oldToken}`).toString('base64');
    containers.set(row!.containerName, {
      Name: `/${row!.containerName}`,
      Config: { Labels: {}, Env: [`HTTPS_PROXY=http://sazuz:${oldToken}@127.0.0.1:18888/`] },
      State: { Running: false, ExitCode: 0, Status: 'exited' },
    });
    const replay = await service({
      ...engine,
      logs: () => {
        const output = Buffer.from(`tokens: ${oldToken} ${encoded}`),
          header = Buffer.alloc(8);
        header[0] = 1;
        header.writeUInt32BE(output.length, 4);
        return Promise.resolve(Buffer.concat([header, output]));
      },
    }).verify(ctx, args);
    expect(replay.status).toBe('done');
    expect(JSON.stringify(replay)).not.toContain(oldToken);
    expect(JSON.stringify(replay)).not.toContain(encoded);
    expect(JSON.stringify(await fixture.db.orm.select().from(sandboxExecutions))).not.toContain(
      oldToken,
    );
  });
  it('requires an actual policy approval before Analyst code runs and preserves taint and the intent receipt', async () => {
    const run = await mission();
    const tools = new ToolRegistry(createSandboxTools(service()));
    const before = starts;
    const router = {
      generate: (request: { messages: { role: string }[] }) =>
        Promise.resolve({
          text: request.messages.some((message) => message.role === 'tool')
            ? 'The result is 42.'
            : 'Run a calculation.',
          toolCalls: request.messages.some((message) => message.role === 'tool')
            ? []
            : [{ id: 'code-call', name: 'sandbox.run', args }],
          finishReason: 'stop' as const,
          providerId: 'fixture',
          modelId: 'fixture',
          usage: {
            inputTokens: 10,
            outputTokens: 10,
            cachedInputTokens: 0,
            source: 'provider' as const,
          },
          costUsd: 0,
          costEstimated: false,
          latencyMs: 1,
        }),
      generateObject: () => Promise.reject(new Error('Analyst does not plan.')),
    };
    const execute = createDurableExecutor({
      database: fixture.db,
      workerId: 'sandbox-fixture-worker',
      dataDir: fixture.directory,
      getSettings: () => fixture.runtime.settings,
      tools,
      router: () => router,
    });
    await execute.execute(run.run.id);
    let detail = (await getMission(fixture.db, fixture.userId, run.id))!;
    expect(detail.mission.run.status).toBe('waiting_approval');
    expect(starts).toBe(before);
    const approval = detail.approvals[0]!;
    await decideApproval(
      fixture.db,
      fixture.userId,
      approval.id,
      { action: 'approve', version: approval.version, note: '' },
      tools,
      () => fixture.runtime.settings,
    );
    await execute.execute(run.run.id);
    detail = (await getMission(fixture.db, fixture.userId, run.id))!;
    expect(detail.mission.run.status).toBe('completed');
    expect(detail.mission.run.tainted).toBe(true);
    expect(starts - before).toBe(1);
    const [intent] = await fixture.db.orm
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.runId, run.run.id));
    expect(intent?.status).toBe('done');
    expect(JSON.stringify(detail)).not.toContain(canary);
    // Replaying a persisted mission cannot start the confirmed action again.
    await execute.execute(run.run.id);
    expect(starts - before).toBe(1);
  });
  it('exposes owned receipts and honest diagnostics only to an authenticated owner', async () => {
    expect(
      (await fixture.request('GET', '/api/sandbox/executions', undefined, false)).statusCode,
    ).toBe(401);
    const response = await fixture.request('GET', '/api/sandbox/executions');
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(canary);
    const diagnostics = await fixture.request('GET', '/api/sandbox/diagnostics');
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json<{ gpu: string }>().gpu).toBe('unknown');
    const values = await fixture.db.orm.select().from(runs);
    expect(JSON.stringify(values.map((value) => jsonValue(value.checkpoint)))).not.toContain(
      canary,
    );
  });
});
