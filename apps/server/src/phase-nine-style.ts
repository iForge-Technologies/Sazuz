import { z } from 'zod';
import { styleProfileSchema } from '@sazuz/core/skills';
import {
  styleProjectQuerySchema,
  styleSentSourceSchema,
  styleSentPreviewSchema,
  styleComparisonRequestSchema,
  styleComparisonSchema,
  styleVoteSchema,
} from '@sazuz/core/style';
import {
  listStyleSources,
  previewSentStyle,
  compareStyle,
  listStyleComparisons,
  styleComparison,
  voteStyleComparison,
} from '@sazuz/skills';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { createModelServices } from './phase-two.js';
import { emptyRequest, workPath } from './phase-three-shared.js';

export function registerStyleChecks(app: Awaited<ReturnType<typeof createApp>>, runtime: PhaseOne) {
  const db = runtime.database,
    services = createModelServices(runtime);
  app.get(
    '/api/skills/style/sources',
    {
      schema: {
        querystring: styleProjectQuerySchema,
        response: { 200: z.array(styleSentSourceSchema).max(50) },
      },
    },
    async (request) =>
      listStyleSources(db, (await runtime.admin(request)).user.id, request.query.projectId),
  );
  app.post(
    '/api/skills/style/sent-preview',
    {
      schema: { body: styleSentPreviewSchema, response: { 200: styleProfileSchema } },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      await runtime.rateLimit(`style-preview:${user.id}`, 5);
      return previewSentStyle({
        database: db,
        userId: user.id,
        input: request.body,
        getSettings: () => runtime.settings,
        router: services.router,
      });
    },
  );
  app.get(
    '/api/skills/style/comparisons',
    {
      schema: {
        querystring: styleProjectQuerySchema,
        response: { 200: z.array(styleComparisonSchema).max(20) },
      },
    },
    async (request) =>
      listStyleComparisons(db, (await runtime.admin(request)).user.id, request.query.projectId),
  );
  app.get(
    '/api/skills/style/comparisons/:id',
    {
      schema: {
        params: workPath,
        querystring: emptyRequest,
        response: { 200: styleComparisonSchema },
      },
    },
    async (request) =>
      styleComparison(db, (await runtime.admin(request)).user.id, request.params.id),
  );
  app.post(
    '/api/skills/style/comparisons',
    {
      schema: { body: styleComparisonRequestSchema, response: { 200: styleComparisonSchema } },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      await runtime.rateLimit(`style-comparison:${user.id}`, 5);
      return compareStyle({
        database: db,
        userId: user.id,
        input: request.body,
        getSettings: () => runtime.settings,
        router: services.router,
      });
    },
  );
  app.post(
    '/api/skills/style/comparisons/:id/vote',
    {
      schema: { params: workPath, body: styleVoteSchema, response: { 200: styleComparisonSchema } },
    },
    async (request) =>
      voteStyleComparison(
        db,
        (await runtime.admin(request)).user.id,
        request.params.id,
        request.body,
      ),
  );
}
