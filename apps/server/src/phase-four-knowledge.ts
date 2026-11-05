import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { kbChunks, kbSources } from '@sazuz/db';
import { workId } from '@sazuz/core/work';
import {
  sourceUploadSchema,
  sourceUrlSchema,
  sourceSchema,
  chunkSchema,
  knowledgeSearchSchema,
  knowledgeSearchResultSchema,
  generationSchema,
  reindexInputSchema,
} from '@sazuz/core/knowledge';
import {
  addUrlSource,
  billedEmbeddings,
  deleteSource,
  listGenerations,
  listSources,
  publicChunk,
  queueReindex,
  readChunk,
  searchKnowledge,
  uploadSource,
  MemoryError,
} from '@sazuz/memory';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { createModelServices } from './phase-two.js';
import { emptyRequest, workPath } from './phase-three-shared.js';

export function registerKnowledge(app: Awaited<ReturnType<typeof createApp>>, runtime: PhaseOne) {
  const db = runtime.database;
  const services = createModelServices(runtime);
  app.get(
    '/api/kb/sources',
    {
      schema: {
        querystring: z.strictObject({ projectId: workId }),
        response: { 200: z.array(sourceSchema) },
      },
    },
    async (request) =>
      listSources(db, (await runtime.admin(request)).user.id, request.query.projectId),
  );
  app.post(
    '/api/kb/sources/upload',
    {
      bodyLimit: 12_000_000,
      schema: { body: sourceUploadSchema, response: { 200: sourceSchema } },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      await runtime.rateLimit(`kb-upload:${user.id}`, 20);
      return uploadSource(db, user.id, request.body);
    },
  );
  app.post(
    '/api/kb/sources/url',
    { schema: { body: sourceUrlSchema, response: { 200: sourceSchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      await runtime.rateLimit(`kb-upload:${user.id}`, 20);
      return addUrlSource(db, user.id, request.body);
    },
  );
  app.delete(
    '/api/kb/sources/:id',
    {
      schema: {
        params: workPath,
        body: emptyRequest,
        response: { 200: z.strictObject({ deleted: z.number().int() }) },
      },
    },
    async (request) => deleteSource(db, (await runtime.admin(request)).user.id, request.params.id),
  );
  app.get(
    '/api/kb/sources/:id/chunks',
    {
      schema: {
        params: workPath,
        querystring: z.strictObject({
          offset: z.coerce.number().int().min(0).max(10000).default(0),
        }),
        response: { 200: z.array(chunkSchema) },
      },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      const [source] = await db.orm
        .select()
        .from(kbSources)
        .where(and(eq(kbSources.id, request.params.id), eq(kbSources.userId, user.id)));
      if (!source) throw new MemoryError('SOURCE_NOT_FOUND');
      return (
        await db.orm
          .select()
          .from(kbChunks)
          .where(eq(kbChunks.sourceId, source.id))
          .orderBy(asc(kbChunks.ordinal))
          .limit(20)
          .offset(request.query.offset)
      ).map((chunk) => publicChunk(chunk, source));
    },
  );
  app.get(
    '/api/kb/chunks/:id',
    { schema: { params: workPath, response: { 200: chunkSchema } } },
    async (request) => readChunk(db, (await runtime.admin(request)).user.id, request.params.id),
  );
  app.post(
    '/api/kb/search',
    { schema: { body: knowledgeSearchSchema, response: { 200: knowledgeSearchResultSchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      await runtime.rateLimit(`kb-search:${user.id}`, 60);
      return searchKnowledge(
        db,
        user.id,
        request.body,
        billedEmbeddings({
          database: db,
          userId: user.id,
          projectId: request.body.projectId,
          router: services.router,
          getSettings: () => runtime.settings,
        }),
      );
    },
  );
  app.get(
    '/api/kb/indexes',
    { schema: { querystring: reindexInputSchema, response: { 200: z.array(generationSchema) } } },
    async (request) =>
      listGenerations(db, (await runtime.admin(request)).user.id, request.query.projectId),
  );
  app.post(
    '/api/kb/reindex',
    { schema: { body: reindexInputSchema, response: { 200: generationSchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      await runtime.rateLimit(`kb-reindex:${user.id}`, 5);
      const generation = await queueReindex(
        db,
        user.id,
        request.body.projectId,
        runtime.settings,
        true,
      );
      return (await listGenerations(db, user.id, request.body.projectId)).find(
        (row) => row.id === generation.id,
      )!;
    },
  );
}
