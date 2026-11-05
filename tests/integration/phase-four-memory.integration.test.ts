import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshSettings, type SettingsDocument } from '@sazuz/config/settings';
import {
  createMission,
  createProject,
  executionControl,
  getMission,
  knowledgeJobs,
  memories,
  migrateDatabase,
  runs,
  toolCalls,
  users,
  workKey,
  type Database,
} from '@sazuz/db';
import {
  createMemory,
  createMemoryTools,
  createKnowledgeWorker,
  deleteMemory,
  enqueueExtraction,
  extractMemories,
  forgetMemories,
  listMemories,
  memoryContext,
  retryKnowledgeJob,
  searchMemories,
  updateMemory,
} from '../../packages/memory/src/index.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { ToolRegistry } from '../../packages/tools/src/index.js';
import { skillsContext } from '../../packages/skills/src/context.js';
import type { GenerateRequest } from '../../packages/llm/src/contracts.js';
import { createFixtureRouter } from './phase-three-runtime-worker.js';
import { openIntegrationDatabase, type IntegrationDatabase } from './database-fixture.js';

const owner = 'phase4_memory_owner';
const limits = { maxSteps: 10, maxCostUsd: 1, maxWallTimeSeconds: 120 };
const candidates = {
  candidates: [
    {
      kind: 'preference',
      content: 'Prefers short, concise emails.',
      quote: 'I prefer short, concise emails.',
      sensitivity: 'low',
      importance: 0.8,
    },
  ],
};
describe('Phase 4 memory with real PostgreSQL and durable execution', () => {
  let fixture: IntegrationDatabase;
  let db: Database;
  let settings: SettingsDocument;
  let directory: string;
  let projectId: string;
  let otherProjectId: string;
  let owns = false;
  const prompts: GenerateRequest[] = [];
  const workerId = workKey('wrk');
  beforeAll(async () => {
    fixture = await openIntegrationDatabase();
    db = fixture.database;
    await migrateDatabase(db);
    const occupied = await db.pool.query<{ n: number }>(
      'SELECT ((SELECT count(*) FROM users)+(SELECT count(*) FROM installation)+(SELECT count(*) FROM worker_heartbeats))::int AS n',
    );
    if (occupied.rows[0]?.n !== 0)
      throw new Error('Use an empty dedicated test database; existing data was preserved.');
    owns = true;
    directory = await mkdtemp(join(tmpdir(), 'sazuz-phase4-memory-'));
  });
  beforeEach(async () => {
    await db.orm.delete(users).where(eq(users.id, owner));
    await db.pool.query('TRUNCATE TABLE audit_log, audit_chain_state');
    await db.orm.delete(executionControl);
    await db.orm
      .insert(users)
      .values({ id: owner, name: 'Memory fixture', email: 'memory@example.test' });
    projectId = (await createProject(db, owner, { name: 'One scope' })).id;
    otherProjectId = (await createProject(db, owner, { name: 'Another scope' })).id;
    settings = freshSettings();
    prompts.length = 0;
  });
  afterAll(async () => {
    if (owns) {
      await db.orm.delete(users).where(eq(users.id, owner));
      await db.pool.query('TRUNCATE TABLE audit_log, audit_chain_state');
      await db.orm.delete(executionControl);
    }
    await fixture?.close();
    if (
      directory &&
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
      directory.includes('sazuz-phase4-memory-')
    )
      await rm(directory, { recursive: true, force: true });
  });
  function executor(
    router = createFixtureRouter({ onGenerate: (request) => prompts.push(request) }),
  ) {
    return createDurableExecutor({
      database: db,
      workerId,
      dataDir: directory,
      getSettings: () => settings,
      tools: new ToolRegistry(createMemoryTools(db)),
      router: () => router,
      complete: enqueueExtraction,
      buildContext: async (input, messages) => {
        const memory = await memoryContext(db, input, messages);
        const skillIndex = await skillsContext(db, input.userId, memory.messages);
        return {
          ...memory,
          messages: skillIndex.messages,
          tainted: memory.tainted || skillIndex.tainted,
        };
      },
    });
  }
  async function mission(goal: string, project = projectId) {
    return createMission(
      db,
      owner,
      { projectId: project, goal, agent: 'researcher', requestId: randomUUID() },
      limits,
    );
  }
  function extractionWorker(plan: unknown = candidates) {
    return createKnowledgeWorker({
      database: db,
      workerId,
      getSettings: () => settings,
      router: () => createFixtureRouter({ plan, onGenerate: (request) => prompts.push(request) }),
    });
  }
  it('extracts a proposal, applies its reviewed preference in a second thread, and excludes another project', async () => {
    const first = await mission('I prefer short, concise emails.');
    await executor().execute(first.run.id);
    expect((await getMission(db, owner, first.id))?.mission.run.status).toBe('completed');
    await extractionWorker().tick();
    const [proposal] = await listMemories(db, owner);
    expect(proposal).toMatchObject({
      status: 'proposed',
      sourceRunId: first.run.id,
      sourceQuote: candidates.candidates[0]!.quote,
    });
    expect(proposal!.sourceMessageId).toMatch(/^msg_/);
    expect(prompts.at(-1)?.role).toBe('fast');
    expect(prompts.at(-1)?.tools).toBeUndefined();
    expect(JSON.stringify(prompts.at(-1)?.messages)).toContain('<untrusted>');
    await updateMemory(db, owner, proposal!.id, {
      version: proposal!.version,
      content: proposal!.content,
      importance: proposal!.importance,
      status: 'accepted',
    });
    const second = await mission('Please draft an invitation to a meeting.');
    expect(second.threadId).not.toBe(first.threadId);
    await executor().execute(second.run.id);
    const detail = await getMission(db, owner, second.id);
    expect(detail?.steps.find((step) => step.kind === 'assistant')?.prompt).toContain(
      'Prefers short, concise emails.',
    );
    expect(detail?.mission.run.tainted).toBe(true);
    const third = await mission('Please draft an invitation to a meeting.', otherProjectId);
    await executor().execute(third.run.id);
    expect((await getMission(db, owner, third.id))?.steps[0]?.prompt).not.toContain(
      'Prefers short, concise emails.',
    );
  });
  it('deletion and forget remove memories from the next query and context immediately', async () => {
    const memory = await createMemory(db, owner, {
      scope: 'project',
      projectId,
      kind: 'preference',
      content: 'Prefers plum headings.',
    });
    expect(await searchMemories(db, owner, { projectId, query: 'report' })).toHaveLength(1);
    await deleteMemory(db, owner, memory.id, memory.version);
    expect(await searchMemories(db, owner, { projectId, query: 'report' })).toEqual([]);
    const ctx = await memoryContext(
      db,
      { userId: owner, projectId, agentId: 'researcher', query: '' },
      [{ role: 'system', content: 'System' }],
    );
    expect(JSON.stringify(ctx.messages)).not.toContain('plum');
    await createMemory(db, owner, {
      scope: 'project',
      projectId,
      kind: 'fact',
      content: 'Project uses plum headings.',
    });
    await createMemory(db, owner, {
      scope: 'global',
      kind: 'fact',
      content: 'Global plum orchard.',
    });
    expect(await forgetMemories(db, owner, { projectId, text: 'plum' })).toEqual({ deleted: 1 });
    expect(await listMemories(db, owner)).toHaveLength(1);
  });
  it('enforces agent and owner scope and rejects stale writes', async () => {
    const memory = await createMemory(db, owner, {
      scope: 'agent',
      projectId,
      agentId: 'coder',
      kind: 'preference',
      content: 'Prefers concise code reviews.',
    });
    expect(await searchMemories(db, owner, { projectId, agentId: 'researcher' })).toEqual([]);
    expect(await searchMemories(db, owner, { projectId, agentId: 'coder' })).toHaveLength(1);
    await expect(
      searchMemories(db, 'another-owner', { projectId, agentId: 'coder' }),
    ).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    await expect(
      updateMemory(db, owner, memory.id, {
        version: 99,
        content: 'Changed',
        importance: 0.5,
        status: 'accepted',
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' });
  });
  it('does not recreate a deleted tool proposal when verifying/replaying its intent', async () => {
    const value = await mission('Remember this preference.');
    const tools = new ToolRegistry(createMemoryTools(db));
    const engine = executor(
      createFixtureRouter({
        toolName: 'memory.propose',
        args: { kind: 'preference', content: 'Prefers concise summaries.' },
      }),
    );
    await engine.execute(value.run.id);
    const [proposal] = await listMemories(db, owner);
    const [intent] = await db.orm.select().from(toolCalls).where(eq(toolCalls.runId, value.run.id));
    expect(intent?.status).toBe('done');
    await deleteMemory(db, owner, proposal!.id, proposal!.version);
    const context = {
      workspaceDir: directory,
      projectId,
      runId: value.run.id,
      agentId: 'researcher',
      idempotencyKey: intent!.idempotencyKey,
      signal: new AbortController().signal,
    };
    expect(await tools.verify('memory.propose', context, intent!.args)).toMatchObject({
      status: 'done',
    });
    await tools.execute('memory.propose', context, intent!.args);
    expect(await listMemories(db, owner)).toEqual([]);
    await engine.execute(value.run.id);
    expect(await listMemories(db, owner)).toEqual([]);
  });
  it('auto-accepts only when enabled, deduplicates completion, and preserves exact provenance', async () => {
    settings.memory.value.autoAccept = true;
    const value = await mission('I prefer short, concise emails.');
    const engine = executor();
    await engine.execute(value.run.id);
    await engine.execute(value.run.id);
    expect((await getMission(db, owner, value.id))?.mission.run.tainted).toBe(true);
    expect(await db.orm.select().from(knowledgeJobs)).toHaveLength(1);
    await extractionWorker().tick();
    await extractionWorker().tick();
    expect(await listMemories(db, owner)).toMatchObject([
      { status: 'accepted', sourceRunId: value.run.id },
    ]);
  });
  it('keeps quoted preferences from untrusted trigger input subject to review', async () => {
    settings.memory.value.autoAccept = true;
    const value = await createMission(
      db,
      owner,
      {
        projectId,
        goal: 'I prefer short, concise emails.',
        agent: 'researcher',
        requestId: randomUUID(),
      },
      limits,
      'trigger',
      true,
    );
    await executor().execute(value.run.id);
    await extractionWorker().tick();
    expect(await listMemories(db, owner)).toMatchObject([
      { status: 'proposed', sourceRunId: value.run.id },
    ]);
  });
  it('rejects unsupported model quotations transactionally', async () => {
    const value = await mission('An ordinary task.');
    await executor().execute(value.run.id);
    const router = createFixtureRouter({ plan: candidates });
    await expect(
      extractMemories({
        database: db,
        runId: value.run.id,
        autoAccept: true,
        generate: router.generateObject.bind(router),
        request: { role: 'fast', privateOnly: false, remainingBudgetUsd: 0.1 },
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_INVALID' });
    expect(await db.orm.select().from(memories)).toEqual([]);
  });
  it('routes private retrieved data only to local models and persists the restriction', async () => {
    await createMemory(db, owner, {
      scope: 'project',
      projectId,
      kind: 'preference',
      content: 'Prefers concise private summaries.',
      sensitivity: 'private',
    });
    const value = await mission('Draft a summary.');
    await executor().execute(value.run.id);
    expect(prompts.at(-1)?.privateOnly).toBe(true);
    const [run] = await db.orm.select().from(runs).where(eq(runs.id, value.run.id));
    expect(run?.checkpoint).toMatchObject({ loop: { privateOnly: true } });
    const tools = new ToolRegistry(createMemoryTools(db));
    const output = await tools.execute(
      'memory.search',
      {
        workspaceDir: directory,
        projectId,
        runId: value.run.id,
        agentId: 'researcher',
        idempotencyKey: '',
        signal: new AbortController().signal,
      },
      { query: '' },
    );
    expect(output.privateOnly).toBe(true);
  });
  it('pauses interrupted jobs for review, and enforces the original run step budget', async () => {
    const value = await mission('I prefer short, concise emails.');
    await executor().execute(value.run.id);
    const [job] = await db.orm.select().from(knowledgeJobs);
    await db.orm
      .update(knowledgeJobs)
      .set({ status: 'running', workerId: 'lost-worker', claimKey: randomUUID() })
      .where(eq(knowledgeJobs.id, job!.id));
    await extractionWorker().tick();
    expect((await db.orm.select().from(knowledgeJobs))[0]).toMatchObject({
      status: 'blocked',
      errorCode: 'JOB_INTERRUPTED',
    });
    await retryKnowledgeJob(db, owner, job!.id);
    await db.orm.update(runs).set({ step: limits.maxSteps }).where(eq(runs.id, value.run.id));
    await extractionWorker().tick();
    expect((await db.orm.select().from(knowledgeJobs))[0]).toMatchObject({
      status: 'blocked',
      errorCode: 'JOB_BUDGET',
    });
    expect(
      await db.orm
        .select()
        .from(memories)
        .where(and(eq(memories.userId, owner), eq(memories.projectId, projectId))),
    ).toEqual([]);
  });
});
