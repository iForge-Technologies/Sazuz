import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { freshSettings } from '@sazuz/config/settings';
import { s2aGraphSchema } from '@sazuz/core/s2a';
import {
  approvals,
  createProject,
  executionControl,
  migrateDatabase,
  missionContext,
  publishS2a,
  runS2a,
  saveS2a,
  s2aExecutions,
  s2aSchedules,
  missions,
  users,
} from '@sazuz/db';
import { tickS2aSchedules } from '../../packages/runtime/src/s2a-scheduler.js';
import { ToolRegistry, defineTool } from '../../packages/tools/src/index.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { decideApproval } from '../../packages/runtime/src/durable-store.js';
import { durableCheckpointSchema } from '../../packages/runtime/src/durable-contracts.js';
import { s2aTools } from '../../packages/workflows/src/s2a.js';
import { ensureAgents, getAgent, saveAgent } from '../../packages/orchestrator/src/index.js';
import { openIntegrationDatabase, type IntegrationDatabase } from './database-fixture.js';

describe('S2A versioning and durable execution against PostgreSQL', () => {
  let fixture: IntegrationDatabase;
  let directory: string;
  let projectId: string;
  let owned = false;
  const owner = 's2a_integration_owner';
  const worker = 's2a_integration_worker';
  const settings = freshSettings();
  const limits = { maxSteps: 20, maxCostUsd: 1, maxWallTimeSeconds: 120 };
  beforeAll(async () => {
    fixture = await openIntegrationDatabase();
    await migrateDatabase(fixture.database);
    const occupied = await fixture.database.pool.query<{ count: number }>(
      'SELECT ((SELECT count(*) FROM users)+(SELECT count(*) FROM installation)+(SELECT count(*) FROM audit_log))::int AS count',
    );
    if (occupied.rows[0]?.count !== 0)
      throw new Error('S2A tests require an empty dedicated database.');
    directory = await mkdtemp(join(tmpdir(), 'sazuz-s2a-test-'));
    owned = true;
  });
  beforeEach(async () => {
    settings.security.value.preset = 'balanced';
    await fixture.database.orm
      .insert(users)
      .values({ id: owner, name: 'S2A fixture', email: 's2a-fixture@example.test' });
    projectId = (
      await createProject(fixture.database, owner, { name: 'S2A project', budgetUsd: 10 })
    ).id;
    await ensureAgents(fixture.database, owner);
    const agent = await getAgent(fixture.database, owner, 'comms');
    await saveAgent(
      fixture.database,
      owner,
      'comms',
      {
        expectedVersion: agent.version,
        definition: { ...agent.definition, tools: [...agent.definition.tools, 'fixture.deliver'] },
      },
      [],
    );
  });
  afterEach(async () => {
    if (!owned) return;
    await fixture.database.orm.delete(users).where(eq(users.id, owner));
    // The fixture reserved an empty dedicated *_test database before creating these records.
    await fixture.database.pool.query('TRUNCATE TABLE audit_log, audit_chain_state');
    await fixture.database.orm.delete(executionControl);
  });
  afterAll(async () => {
    await fixture?.close();
    if (directory && resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`))
      await rm(directory, { recursive: true, force: true });
  });
  const graph = () =>
    s2aGraphSchema.parse({
      entry: 'prepare',
      nodes: [
        {
          id: 'prepare',
          name: 'Prepare',
          kind: 'value',
          value: '{{input.message}}',
          next: 'approval',
        },
        {
          id: 'approval',
          name: 'Review',
          kind: 'approval',
          message: 'Review this fixture.',
          next: 'send',
        },
        {
          id: 'send',
          name: 'Deliver',
          kind: 'tool',
          agent: 'comms',
          tool: 'fixture.deliver',
          args: { text: '{{nodes.prepare}}' },
          next: null,
        },
      ],
    });
  async function create() {
    const workflow = await saveS2a(fixture.database, owner, {
      projectId,
      name: 'Test workflow',
      graph: graph(),
    });
    await publishS2a(fixture.database, owner, workflow.id, workflow.revision);
    return workflow;
  }
  it('pins revisions, deduplicates submissions and rejects stale edits and changed request bodies', async () => {
    const workflow = await create();
    const input = { requestId: randomUUID(), revision: 1, input: { message: 'Hello' } };
    const first = await runS2a(fixture.database, owner, workflow.id, input, limits);
    expect((await runS2a(fixture.database, owner, workflow.id, input, limits)).id).toBe(first.id);
    await expect(
      runS2a(
        fixture.database,
        owner,
        workflow.id,
        { ...input, input: { message: 'Changed' } },
        limits,
      ),
    ).rejects.toMatchObject({ code: 'MISSION_CONFLICT' });
    const changed = graph();
    changed.nodes[0]!.name = 'Changed name';
    await saveS2a(
      fixture.database,
      owner,
      { name: 'Changed', graph: changed, expectedRevision: 1 },
      workflow.id,
    );
    await expect(
      saveS2a(
        fixture.database,
        owner,
        { name: 'Stale', graph: changed, expectedRevision: 1 },
        workflow.id,
      ),
    ).rejects.toMatchObject({ code: 'MISSION_CONFLICT' });
    const [execution] = await fixture.database.orm
      .select()
      .from(s2aExecutions)
      .where(eq(s2aExecutions.runId, first.run.id));
    expect(execution!.revision).toBe(1);
    expect(JSON.stringify(execution!.snapshot)).not.toContain('Changed name');
    await publishS2a(fixture.database, owner, workflow.id, 2);
    expect((await runS2a(fixture.database, owner, workflow.id, input, limits)).id).toBe(first.id);
  });
  it('suspends for approval, resumes with a replacement executor and performs one effect without model calls', async () => {
    const workflow = await create();
    const mission = await runS2a(
      fixture.database,
      owner,
      workflow.id,
      { requestId: randomUUID(), revision: 1, input: { message: 'Deliver this once' } },
      limits,
    );
    let effects = 0;
    const effect = defineTool({
      name: 'fixture.deliver',
      description: 'Fixture delivery',
      input: z.strictObject({ text: z.string() }),
      output: z.object({ delivered: z.boolean() }),
      effect: 'write',
      scope: 'internal',
      untrusted: false,
      run: (ctx, args) => {
        expect(ctx.agentId).toBe('comms');
        expect(args.text).toBe('Deliver this once');
        effects++;
        return Promise.resolve({ delivered: true });
      },
      verify: () =>
        Promise.resolve(
          effects ? { status: 'done', result: { delivered: true } } : { status: 'not_done' },
        ),
    });
    const tools = new ToolRegistry([effect]);
    const model = vi.fn(() =>
      Promise.reject(new Error('A deterministic workflow must not call a model.')),
    );
    const buildContext = vi.fn(() => Promise.reject(new Error('Unexpected context retrieval.')));
    const complete = vi.fn(() => Promise.resolve());
    const executor = () =>
      createDurableExecutor({
        database: fixture.database,
        workerId: worker,
        dataDir: directory,
        getSettings: () => settings,
        tools,
        buildContext,
        complete,
        router: () => ({ generate: model, generateObject: model }),
      });
    await executor().execute(mission.run.id);
    expect((await missionContext(fixture.database, mission.run.id))!.run.status).toBe(
      'waiting_approval',
    );
    const [approval] = await fixture.database.orm
      .select()
      .from(approvals)
      .where(eq(approvals.runId, mission.run.id));
    expect(approval!.toolName).toBe('s2a.approval');
    await decideApproval(
      fixture.database,
      owner,
      approval!.id,
      { version: approval!.version, action: 'approve', note: '' },
      new ToolRegistry([effect, ...s2aTools()]),
      () => settings,
    );
    await executor().execute(mission.run.id);
    await executor().execute(mission.run.id);
    const run = (await missionContext(fixture.database, mission.run.id))!.run;
    expect(run.status).toBe('completed');
    expect(effects).toBe(1);
    expect(model).not.toHaveBeenCalled();
    expect(buildContext).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(durableCheckpointSchema.parse(run.checkpoint).workflow!.outputs.send).toEqual({
      delivered: true,
    });
  });
  it('stops a denied checkpoint before reaching any subsequent tool', async () => {
    const workflow = await create();
    const mission = await runS2a(
      fixture.database,
      owner,
      workflow.id,
      { requestId: randomUUID(), revision: 1, input: { message: 'Denied' } },
      limits,
    );
    const tools = new ToolRegistry();
    const model = vi.fn(() => Promise.reject(new Error('Unexpected generation.')));
    const executor = createDurableExecutor({
      database: fixture.database,
      workerId: worker,
      dataDir: directory,
      getSettings: () => settings,
      tools,
      router: () => ({ generate: model, generateObject: model }),
    });
    await executor.execute(mission.run.id);
    const [approval] = await fixture.database.orm
      .select()
      .from(approvals)
      .where(eq(approvals.runId, mission.run.id));
    await decideApproval(
      fixture.database,
      owner,
      approval!.id,
      { version: approval!.version, action: 'deny', note: '' },
      new ToolRegistry(s2aTools()),
      () => settings,
    );
    await executor.execute(mission.run.id);
    const run = (await missionContext(fixture.database, mission.run.id))!.run;
    expect(run.status).toBe('failed');
    expect(durableCheckpointSchema.parse(run.checkpoint).workflow!.outputs).not.toHaveProperty(
      'send',
    );
  });
  it('recovers a lost schedule checkpoint without creating another workflow run', async () => {
    const workflow = await create();
    const due = new Date(Date.now() - 60_000);
    await fixture.database.orm.insert(s2aSchedules).values({
      workflowId: workflow.id,
      version: 1,
      expression: '* * * * *',
      timezone: 'UTC',
      enabled: true,
      input: { message: 'Scheduled' },
      nextRunAt: due,
    });
    await tickS2aSchedules(fixture.database, () => settings);
    await fixture.database.orm
      .update(s2aSchedules)
      .set({ nextRunAt: due })
      .where(eq(s2aSchedules.workflowId, workflow.id));
    await tickS2aSchedules(fixture.database, () => settings);
    expect(
      await fixture.database.orm.select().from(missions).where(eq(missions.projectId, projectId)),
    ).toHaveLength(1);
  });
  it('enforces the selected agent permissions before executing a tool node', async () => {
    const workflow = await saveS2a(fixture.database, owner, {
      projectId,
      name: 'Denied tool scope',
      graph: {
        entry: 'effect',
        nodes: [
          {
            id: 'effect',
            name: 'Restricted',
            kind: 'tool',
            agent: 'researcher',
            tool: 'fixture.deliver',
            args: {},
            next: null,
          },
        ],
      },
    });
    await publishS2a(fixture.database, owner, workflow.id, workflow.revision);
    const mission = await runS2a(
      fixture.database,
      owner,
      workflow.id,
      { requestId: randomUUID(), revision: 1, input: {} },
      limits,
    );
    const effect = vi.fn(() => Promise.resolve(true));
    const model = vi.fn(() => Promise.reject(new Error('Unexpected model request')));
    await createDurableExecutor({
      database: fixture.database,
      workerId: worker,
      dataDir: directory,
      getSettings: () => settings,
      tools: new ToolRegistry([
        defineTool({
          name: 'fixture.deliver',
          description: 'Restricted fixture',
          input: z.strictObject({}),
          output: z.boolean(),
          effect: 'send',
          run: effect,
        }),
      ]),
      router: () => ({ generate: model, generateObject: model }),
    }).execute(mission.run.id);
    const run = (await missionContext(fixture.database, mission.run.id))!.run;
    expect(run.status).toBe('failed');
    expect(durableCheckpointSchema.parse(run.checkpoint).workflow?.failure).toBeTruthy();
    expect(effect).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });
  it('runs each agent node with its selected identity and preserves outputs between nodes', async () => {
    const workflow = await saveS2a(fixture.database, owner, {
      projectId,
      name: 'Agent handoff',
      graph: {
        entry: 'write',
        nodes: [
          {
            id: 'write',
            name: 'Write',
            kind: 'agent',
            agent: 'writer',
            prompt: 'Draft a title',
            allowedTools: [],
            next: 'review',
          },
          {
            id: 'review',
            name: 'Review',
            kind: 'agent',
            agent: 'researcher',
            prompt: 'Review the title',
            allowedTools: [],
            next: null,
          },
        ],
      },
    });
    await publishS2a(fixture.database, owner, workflow.id, workflow.revision);
    const mission = await runS2a(
      fixture.database,
      owner,
      workflow.id,
      { requestId: randomUUID(), revision: 1, input: {} },
      limits,
    );
    const identities: string[] = [];
    const generate = vi.fn(async () => {
      const current = await missionContext(fixture.database, mission.run.id);
      identities.push(current!.run.agentId);
      return {
        text: current!.run.agentId + ' result',
        toolCalls: [],
        finishReason: 'stop' as const,
        providerId: 'fixture',
        modelId: 'fixture',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 0,
          source: 'provider' as const,
        },
        costUsd: 0,
        costEstimated: false,
        latencyMs: 1,
      };
    });
    await createDurableExecutor({
      database: fixture.database,
      workerId: worker,
      dataDir: directory,
      getSettings: () => settings,
      tools: new ToolRegistry(),
      router: () => ({ generate, generateObject: vi.fn() }),
    }).execute(mission.run.id);
    const run = (await missionContext(fixture.database, mission.run.id))!.run;
    expect(run.status).toBe('completed');
    expect(identities).toEqual(['writer', 'researcher']);
    expect(durableCheckpointSchema.parse(run.checkpoint).workflow?.outputs).toEqual({
      write: 'writer result',
      review: 'researcher result',
    });
  });
});
