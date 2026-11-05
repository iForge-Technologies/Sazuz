import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshSettings, type SettingsDocument } from '@sazuz/config/settings';
import {
  createMission,
  createProject,
  getMission,
  kbChunks,
  kbEmbeddings,
  knowledgeJobs,
  memoryEmbeddings,
  projects,
  costLedger,
  executionControl,
  workKey,
} from '@sazuz/db';
import { secretRedactor } from '@sazuz/vault';
import { sourceSchema } from '@sazuz/core/knowledge';
import {
  uploadSource,
  addUrlSource,
  ingestSource,
  searchKnowledge,
  readChunk,
  deleteSource,
  createKnowledgeTools,
  createKnowledgeWorker,
  activeGeneration,
  queueReindex,
  buildIndex,
  createMemory,
  deleteMemory,
  hybridMemorySearch,
  billedEmbeddings,
  retryKnowledgeJob,
  type EmbedBatch,
} from '../../packages/memory/src/index.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { ToolRegistry, type SafeNetworkDependencies } from '../../packages/tools/src/index.js';
import { createFixtureRouter } from './phase-three-runtime-worker.js';
import { phaseFourFixture } from './phase-four-fixture.js';

describe('Phase 4 knowledge, pgvector generations and cited answers', () => {
  let f: Awaited<ReturnType<typeof phaseFourFixture>>;
  let projectId: string, settings: SettingsDocument;
  const signal = () => AbortSignal.timeout(10000);
  const embed: EmbedBatch = (target, texts) =>
    Promise.resolve({
      providerId: target.providerId,
      modelId: target.modelId,
      dimensions: target.modelId === 'second' ? 2 : 3,
      costUsd: 0,
      vectors: texts.map(() => (target.modelId === 'second' ? [1, 0] : [1, 0, 0])),
    });
  beforeAll(async () => {
    f = await phaseFourFixture();
  });
  beforeEach(async () => {
    await f.db.orm.delete(knowledgeJobs);
    await f.db.orm.delete(projects).where(eq(projects.userId, f.userId));
    await f.db.orm.delete(executionControl);
    await f.db.orm.delete(costLedger);
    projectId = (await createProject(f.db, f.userId, { name: 'Knowledge case' })).id;
    settings = freshSettings();
    settings.providers.value.items = [
      {
        id: 'vectors',
        name: 'Vector fixture',
        kind: 'openai-compatible',
        baseUrl: 'https://vectors.example.test/v1',
        locality: 'local',
        secretRef: null,
        enabled: true,
      },
    ];
    settings.models.value.roles.embedding = { providerId: 'vectors', modelId: 'first' };
  });
  afterAll(async () => {
    await f?.close();
  });
  async function source(text = 'Orchid is the launch identifier. The release date is November 3.') {
    const row = await uploadSource(f.db, f.userId, {
      projectId,
      requestId: randomUUID(),
      kind: 'md',
      name: 'Launch notes.md',
      base64: Buffer.from(text).toString('base64'),
    });
    await ingestSource(f.db, row.id, signal());
    await f.db.orm
      .update(knowledgeJobs)
      .set({ status: 'completed' })
      .where(eq(knowledgeJobs.sourceId, row.id));
    return row;
  }
  async function index() {
    const generation = await queueReindex(f.db, f.userId, projectId, settings);
    await buildIndex(f.db, generation.id, () => settings, embed, signal());
    return generation;
  }
  it('ingests idempotently, returns source-located full-text passages, and enforces project ownership', async () => {
    const row = await source();
    await ingestSource(f.db, row.id, signal());
    const result = await searchKnowledge(f.db, f.userId, { projectId, query: 'Orchid' });
    expect(result.mode).toBe('full-text');
    expect(result.notice).toContain('Configure an embedding model');
    expect(result.matches).toHaveLength(1);
    const chunk = result.matches[0]!;
    expect(chunk).toMatchObject({
      sourceId: row.id,
      sourceName: 'Launch notes.md',
      locator: 'Document text · chunk 1',
    });
    expect(await readChunk(f.db, f.userId, chunk.id, projectId)).toEqual(chunk);
    await expect(readChunk(f.db, 'another-owner', chunk.id)).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND',
    });
    await expect(readChunk(f.db, f.userId, chunk.id, workKey('prj'))).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND',
    });
    expect(
      (await searchKnowledge(f.db, f.userId, { projectId, query: 'Orchid', tokenBudget: 100 }))
        .matches,
    ).toEqual([]);
  });
  it('fetches URLs with pinned public addresses and rejects private redirect targets', async () => {
    const transport = vi.fn<NonNullable<SafeNetworkDependencies['request']>>().mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<h1>Release</h1><p>Orchid.</p><script>untrusted code</script>',
    });
    const network: SafeNetworkDependencies = {
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      request: transport,
    };
    const row = await addUrlSource(
      f.db,
      f.userId,
      {
        projectId,
        requestId: randomUUID(),
        name: 'Release URL',
        url: 'https://example.com/release',
      },
      network,
    );
    await ingestSource(f.db, row.id, signal(), network);
    expect(transport.mock.calls[0]?.[0].address.address).toBe('93.184.216.34');
    expect(
      (await searchKnowledge(f.db, f.userId, { projectId, query: 'Orchid' })).matches[0]?.text,
    ).not.toContain('untrusted code');
    const redirect = await addUrlSource(
      f.db,
      f.userId,
      { projectId, requestId: randomUUID(), name: 'Redirect', url: 'https://example.com/redirect' },
      network,
    );
    transport.mockResolvedValue({
      status: 302,
      headers: { location: 'http://127.0.0.1/private' },
      body: '',
    });
    await expect(ingestSource(f.db, redirect.id, signal(), network)).rejects.toBeInstanceOf(Error);
    await expect(
      addUrlSource(
        f.db,
        f.userId,
        { projectId, requestId: randomUUID(), name: 'Private', url: 'http://127.0.0.1/private' },
        network,
      ),
    ).rejects.toBeInstanceOf(Error);
  });
  it('keeps the old generation available until a complete atomic swap and never mixes dimensions', async () => {
    await source();
    const first = await index();
    expect(
      (await searchKnowledge(f.db, f.userId, { projectId, query: 'deployment label' }, embed))
        .generationId,
    ).toBe(first.id);
    settings.models.value.roles.embedding = { providerId: 'vectors', modelId: 'second' };
    const second = await queueReindex(f.db, f.userId, projectId, settings);
    expect((await activeGeneration(f.db, projectId))?.id).toBe(first.id);
    await expect(
      buildIndex(
        f.db,
        second.id,
        () => settings,
        () => Promise.reject(new Error('Fixture provider unavailable')),
        signal(),
      ),
    ).rejects.toThrow('Fixture provider unavailable');
    expect((await activeGeneration(f.db, projectId))?.id).toBe(first.id);
    await buildIndex(f.db, second.id, () => settings, embed, signal());
    const result = await searchKnowledge(
      f.db,
      f.userId,
      { projectId, query: 'deployment label' },
      embed,
    );
    expect(result.mode).toBe('hybrid');
    expect(result.generationId).toBe(second.id);
    expect(result.matches).toHaveLength(1);
    const inconsistent: EmbedBatch = async (target) => ({
      ...(await embed(target, ['query'], false)),
      vectors: [[1, 0, 0]],
    });
    expect(
      (await searchKnowledge(f.db, f.userId, { projectId, query: 'Orchid' }, inconsistent)).mode,
    ).toBe('full-text');
    expect(await queueReindex(f.db, f.userId, projectId, settings)).toMatchObject({
      id: second.id,
    });
  });
  it('removes memory vectors immediately and does not resurrect a deleted memory during reindex', async () => {
    await source();
    const memory = await createMemory(f.db, f.userId, {
      scope: 'project',
      projectId,
      kind: 'preference',
      content: 'Prefers plum headings.',
    });
    const first = await index();
    expect(
      (await hybridMemorySearch(f.db, f.userId, { projectId, query: 'report' }, embed)).map(
        (row) => row.id,
      ),
    ).toContain(memory.id);
    const pending = await queueReindex(f.db, f.userId, projectId, settings, true);
    await expect(
      buildIndex(
        f.db,
        pending.id,
        () => settings,
        async (target, texts, privateOnly) => {
          await deleteMemory(f.db, f.userId, memory.id, memory.version);
          return embed(target, texts, privateOnly);
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'EMBEDDING_SPACE' });
    expect(await hybridMemorySearch(f.db, f.userId, { projectId, query: 'report' }, embed)).toEqual(
      [],
    );
    expect(
      await f.db.orm
        .select()
        .from(memoryEmbeddings)
        .where(eq(memoryEmbeddings.memoryId, memory.id)),
    ).toEqual([]);
    expect((await activeGeneration(f.db, projectId))?.id).toBe(first.id);
    const chunk = (await searchKnowledge(f.db, f.userId, { projectId, query: 'Orchid' }))
      .matches[0]!;
    await deleteSource(f.db, f.userId, chunk.sourceId);
    expect(
      await f.db.orm.select().from(kbEmbeddings).where(eq(kbEmbeddings.chunkId, chunk.id)),
    ).toEqual([]);
    expect(
      (await searchKnowledge(f.db, f.userId, { projectId, query: 'Orchid' }, embed)).matches,
    ).toEqual([]);
  });
  it('rejects cloud indexing for private projects and excludes private memories from cloud corpora', async () => {
    await source();
    const privateMemory = await createMemory(f.db, f.userId, {
      scope: 'project',
      projectId,
      kind: 'fact',
      content: 'A private launch detail.',
      sensitivity: 'private',
    });
    settings.providers.value.items[0]!.locality = 'cloud';
    await index();
    expect(
      await f.db.orm
        .select()
        .from(memoryEmbeddings)
        .where(eq(memoryEmbeddings.memoryId, privateMemory.id)),
    ).toEqual([]);
    await f.db.orm.update(projects).set({ privacy: 'private' }).where(eq(projects.id, projectId));
    await expect(queueReindex(f.db, f.userId, projectId, settings, true)).rejects.toMatchObject({
      code: 'EMBEDDING_PRIVATE',
    });
    settings.providers.value.items[0]!.locality = 'local';
    const local = await queueReindex(f.db, f.userId, projectId, settings, true);
    await buildIndex(f.db, local.id, () => settings, embed, signal());
    expect(
      await f.db.orm
        .select()
        .from(memoryEmbeddings)
        .where(
          and(
            eq(memoryEmbeddings.generationId, local.id),
            eq(memoryEmbeddings.memoryId, privateMemory.id),
          ),
        ),
    ).toHaveLength(1);
  });
  it('persists ingestion and indexing jobs, stops uncertain work, and requires an explicit retry', async () => {
    await source();
    const generation = await queueReindex(f.db, f.userId, projectId, settings);
    const workerId = workKey('wrk');
    const worker = createKnowledgeWorker({
      database: f.db,
      workerId,
      getSettings: () => settings,
      router: () => ({
        ...createFixtureRouter(),
        embed: async (request) =>
          embed(
            {
              providerId: request.providerId,
              modelId: request.modelId,
              providerUrl: settings.providers.value.items[0]!.baseUrl,
              locality: 'local',
            },
            request.texts,
            request.privateOnly,
          ),
      }),
    });
    const [job] = await f.db.orm
      .select()
      .from(knowledgeJobs)
      .where(eq(knowledgeJobs.eventKey, `reindex:${generation.id}`));
    await f.db.orm
      .update(knowledgeJobs)
      .set({ status: 'running', workerId, claimKey: randomUUID() })
      .where(eq(knowledgeJobs.id, job!.id));
    await worker.tick();
    expect(
      (await f.db.orm.select().from(knowledgeJobs).where(eq(knowledgeJobs.id, job!.id)))[0],
    ).toMatchObject({ status: 'blocked', errorCode: 'JOB_INTERRUPTED' });
    expect(await activeGeneration(f.db, projectId)).toBeUndefined();
    await retryKnowledgeJob(f.db, f.userId, job!.id);
    await worker.tick();
    expect((await activeGeneration(f.db, projectId))?.id).toBe(generation.id);
    expect(
      (await f.db.orm.select().from(knowledgeJobs).where(eq(knowledgeJobs.id, job!.id)))[0]?.status,
    ).toBe('completed');
  });
  it('charges query embeddings under the spending lock and refuses changed provider endpoints or global pause', async () => {
    const target = {
      providerId: 'vectors',
      modelId: 'first',
      providerUrl: settings.providers.value.items[0]!.baseUrl,
      locality: 'local' as const,
    };
    const router = {
      embed: vi.fn(
        async (
          request: Parameters<Parameters<typeof billedEmbeddings>[0]['router']['embed']>[0],
        ) => {
          await request.onUsage?.({
            providerId: 'vectors',
            modelId: 'first',
            usage: { inputTokens: 10, outputTokens: 0, cachedInputTokens: 0, source: 'provider' },
            costUsd: 0.001,
            costEstimated: false,
            latencyMs: 1,
            status: 'completed',
          });
          return embed(target, request.texts, request.privateOnly);
        },
      ),
    };
    const billed = billedEmbeddings({
      database: f.db,
      userId: f.userId,
      projectId,
      getSettings: () => settings,
      router,
    });
    await billed(target, ['Orchid'], false);
    expect((await f.db.orm.select().from(costLedger))[0]).toMatchObject({
      projectId,
      agentId: 'knowledge-search',
      costUsd: 0.001,
    });
    settings.providers.value.items[0]!.baseUrl = 'https://changed.example.test';
    await expect(billed(target, ['Orchid'], false)).rejects.toMatchObject({
      code: 'EMBEDDING_UNAVAILABLE',
    });
    await f.db.orm
      .update(executionControl)
      .set({ paused: true })
      .where(eq(executionControl.id, 'singleton'));
    await expect(billed(target, ['Orchid'], false)).rejects.toMatchObject({
      code: 'JOB_INTERRUPTED',
    });
    expect(router.embed).toHaveBeenCalledOnce();
  });
  it('produces a durable cited answer from kb.search with untrusted prompt evidence', async () => {
    await source();
    await index();
    const chunk = (await searchKnowledge(f.db, f.userId, { projectId, query: 'Orchid' }, embed))
      .matches[0]!;
    const mission = await createMission(
      f.db,
      f.userId,
      {
        projectId,
        goal: 'What is the launch identifier? Cite the source.',
        agent: 'researcher',
        requestId: randomUUID(),
      },
      { maxSteps: 8, maxCostUsd: 1, maxWallTimeSeconds: 120 },
    );
    const executor = createDurableExecutor({
      database: f.db,
      workerId: workKey('wrk'),
      dataDir: f.directory,
      getSettings: () => settings,
      tools: new ToolRegistry(createKnowledgeTools(f.db, () => embed)),
      router: () =>
        createFixtureRouter({
          toolName: 'kb.search',
          args: { query: 'launch identifier' },
          text: `The launch identifier is Orchid. ${chunk.citation}`,
        }),
    });
    await executor.execute(mission.run.id);
    const result = await getMission(f.db, f.userId, mission.id);
    expect(result?.mission.run).toMatchObject({ status: 'completed', tainted: true });
    const answer = result?.steps.filter((step) => step.kind === 'assistant').at(-1);
    expect(answer?.content).toContain(chunk.citation);
    expect(answer?.prompt).toContain('<untrusted>');
    expect(answer?.prompt).toContain(chunk.text);
    expect((await readChunk(f.db, f.userId, chunk.id)).sourceId).toBe(chunk.sourceId);
  });
  it('authenticates and validates source APIs, protects secrets, and round-trips source citations', async () => {
    const laterSecret = 'newly-registered-secret-8019762';
    const prior = await source(`A value registered later: ${laterSecret}`);
    secretRedactor.register(laterSecret);
    expect((await f.request('GET', `/api/kb/sources/${prior.id}/chunks`)).body).not.toContain(
      laterSecret,
    );
    expect(
      (
        await f.request('POST', '/api/kb/sources/url', {
          projectId,
          requestId: randomUUID(),
          name: 'Private host',
          url: 'http://127.0.0.1/private',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await f.request('GET', `/api/kb/sources?projectId=${projectId}`, undefined, false))
        .statusCode,
    ).toBe(401);
    const body = {
      projectId,
      requestId: randomUUID(),
      kind: 'html',
      name: 'Release',
      base64: Buffer.from('<p>Orchid release.</p>').toString('base64'),
    };
    expect(
      (await f.request('POST', '/api/kb/sources/upload', body, true, 'https://attacker.test'))
        .statusCode,
    ).toBe(403);
    const uploaded = await f.request('POST', '/api/kb/sources/upload', body);
    expect(uploaded.statusCode).toBe(200);
    const row = sourceSchema.parse(uploaded.json());
    expect(
      sourceSchema.parse((await f.request('POST', '/api/kb/sources/upload', body)).json()).id,
    ).toBe(row.id);
    await ingestSource(f.db, row.id, signal());
    const chunks = await f.request('GET', `/api/kb/sources/${row.id}/chunks`);
    expect(chunks.statusCode).toBe(200);
    const [chunk] = await f.db.orm.select().from(kbChunks).where(eq(kbChunks.sourceId, row.id));
    expect((await f.request('GET', `/api/kb/chunks/${chunk!.id}`)).body).toContain(
      'Orchid release.',
    );
    expect(
      (await f.request('POST', '/api/kb/search', { projectId, query: 'Orchid' })).body,
    ).toContain(chunk!.id);
    const canary = 'knowledge-fixture-secret-4976201';
    secretRedactor.register(canary);
    const rejected = await f.request('POST', '/api/kb/sources/upload', {
      ...body,
      requestId: randomUUID(),
      base64: Buffer.from(`<p>${canary}</p>`).toString('base64'),
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).not.toContain(canary);
    expect((await f.request('DELETE', `/api/kb/sources/${row.id}`, {})).statusCode).toBe(200);
    expect((await f.request('GET', `/api/kb/chunks/${chunk!.id}`)).statusCode).toBe(404);
    expect(f.logLines.join('')).not.toContain(canary);
  });
});
