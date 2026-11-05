import { z } from 'zod';
import {
  memoryInputSchema,
  memoryQuerySchema,
  memorySchema,
  memorySearchSchema,
  memoryUpdateSchema,
  forgetMemorySchema,
  knowledgeJobSchema,
} from '@sazuz/core/memory';
import {
  createMemory,
  deleteMemory,
  forgetMemories,
  listKnowledgeJobs,
  listMemories,
  retryKnowledgeJob,
  hybridMemorySearch,
  billedEmbeddings,
  updateMemory,
} from '@sazuz/memory';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { emptyRequest, parseRequest, workPath } from './phase-three-shared.js';
import { registerKnowledge } from './phase-four-knowledge.js';
import { registerSkills } from './phase-four-skills.js';
import { registerRecipes } from './phase-four-recipes.js';
import { createModelServices } from './phase-two.js';

export function registerPhaseFour(app: Awaited<ReturnType<typeof createApp>>, runtime: PhaseOne) {
  const { database } = runtime;
  const services = createModelServices(runtime);
  registerKnowledge(app, runtime);
  registerSkills(app, runtime);
  registerRecipes(app, runtime);
  app.get(
    '/api/memory',
    { schema: { querystring: memoryQuerySchema, response: { 200: z.array(memorySchema) } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      return listMemories(database, user.id, request.query);
    },
  );
  app.post(
    '/api/memory',
    { schema: { body: memoryInputSchema, response: { 200: memorySchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      return createMemory(database, user.id, request.body);
    },
  );
  app.put(
    '/api/memory/:id',
    { schema: { params: workPath, body: memoryUpdateSchema, response: { 200: memorySchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      return updateMemory(database, user.id, request.params.id, request.body);
    },
  );
  app.delete(
    '/api/memory/:id',
    {
      schema: {
        params: workPath,
        body: z.strictObject({ version: z.number().int().positive() }),
        response: { 200: z.strictObject({ deleted: z.number().int() }) },
      },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      return deleteMemory(database, user.id, request.params.id, request.body.version);
    },
  );
  app.post(
    '/api/memory/forget',
    {
      schema: {
        body: forgetMemorySchema,
        response: { 200: z.strictObject({ deleted: z.number().int() }) },
      },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      return forgetMemories(database, user.id, request.body);
    },
  );
  app.post(
    '/api/memory/search',
    { schema: { body: memorySearchSchema, response: { 200: z.array(memorySchema) } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      await runtime.rateLimit(`memory-search:${user.id}`, 60);
      return hybridMemorySearch(
        database,
        user.id,
        request.body,
        billedEmbeddings({
          database,
          userId: user.id,
          projectId: request.body.projectId,
          getSettings: () => runtime.settings,
          router: services.router,
        }),
      );
    },
  );
  app.get(
    '/api/memory/jobs',
    { schema: { response: { 200: z.array(knowledgeJobSchema) } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      parseRequest(emptyRequest, request.query);
      return listKnowledgeJobs(database, user.id);
    },
  );
  app.post(
    '/api/memory/jobs/:id/retry',
    { schema: { params: workPath, body: emptyRequest, response: { 200: knowledgeJobSchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      return retryKnowledgeJob(database, user.id, request.params.id);
    },
  );
}
