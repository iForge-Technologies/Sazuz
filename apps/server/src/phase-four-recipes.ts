import { z } from 'zod';
import {
  recipeInstallationSchema,
  recipePreviewInputSchema,
  recipeTemplateSchema,
} from '@sazuz/core/recipes';
import {
  installRecipe,
  listRecipeInstallations,
  previewRecipe,
  readRecipeTemplates,
} from '@sazuz/runtime';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { emptyRequest, workPath } from './phase-three-shared.js';

export function registerRecipes(app: Awaited<ReturnType<typeof createApp>>, runtime: PhaseOne) {
  app.get(
    '/api/recipes',
    { schema: { querystring: emptyRequest, response: { 200: z.array(recipeTemplateSchema) } } },
    async (request) => {
      await runtime.admin(request);
      return readRecipeTemplates();
    },
  );
  app.get(
    '/api/recipes/installations',
    { schema: { querystring: emptyRequest, response: { 200: z.array(recipeInstallationSchema) } } },
    async (request) =>
      listRecipeInstallations(runtime.database, (await runtime.admin(request)).user.id),
  );
  app.post(
    '/api/recipes/preview',
    { schema: { body: recipePreviewInputSchema, response: { 200: recipeInstallationSchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      await runtime.rateLimit(`recipe-preview:${user.id}`, 30);
      return previewRecipe(runtime.database, user.id, request.body, runtime.settings);
    },
  );
  app.post(
    '/api/recipes/:id/install',
    {
      schema: { params: workPath, body: emptyRequest, response: { 200: recipeInstallationSchema } },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      await runtime.rateLimit(`recipe-install:${user.id}`, 30);
      return installRecipe(runtime.database, user.id, request.params.id, runtime.settings);
    },
  );
}
