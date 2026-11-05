import { z } from 'zod';
import {
  skillSummarySchema,
  skillVersionSchema,
  skillWriteSchema,
  styleProfileSchema,
  styleRequestSchema,
} from '@sazuz/core/skills';
import {
  acceptStyle,
  listSkills,
  listStyleProfiles,
  previewStyle,
  saveSkill,
  skillVersion,
  versions,
} from '@sazuz/skills';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { createModelServices } from './phase-two.js';
import { emptyRequest, workPath } from './phase-three-shared.js';
import { registerLearning } from './phase-nine-learning.js';
import { registerStyleChecks } from './phase-nine-style.js';
import { registerSkillProposals } from './phase-nine-proposals.js';

export function registerSkills(app: Awaited<ReturnType<typeof createApp>>, runtime: PhaseOne) {
  registerLearning(app, runtime);
  registerStyleChecks(app, runtime);
  registerSkillProposals(app, runtime);
  const db = runtime.database,
    services = createModelServices(runtime);
  app.get(
    '/api/skills',
    { schema: { querystring: emptyRequest, response: { 200: z.array(skillSummarySchema) } } },
    async (request) => listSkills(db, (await runtime.admin(request)).user.id),
  );
  app.get(
    '/api/skills/:id',
    {
      schema: {
        params: workPath,
        querystring: z.strictObject({ revision: z.coerce.number().int().positive().optional() }),
        response: { 200: skillVersionSchema },
      },
    },
    async (request) =>
      skillVersion(
        db,
        (await runtime.admin(request)).user.id,
        request.params.id,
        request.query.revision,
      ),
  );
  app.get(
    '/api/skills/:id/versions',
    {
      schema: {
        params: workPath,
        querystring: emptyRequest,
        response: {
          200: z.array(
            z.strictObject({
              revision: z.number().int().positive(),
              sha256: z.string(),
              createdAt: z.iso.datetime(),
            }),
          ),
        },
      },
    },
    async (request) => versions(db, (await runtime.admin(request)).user.id, request.params.id),
  );
  app.post(
    '/api/skills',
    { schema: { body: skillWriteSchema, response: { 200: skillVersionSchema } } },
    async (request) => saveSkill(db, (await runtime.admin(request)).user.id, request.body),
  );
  app.put(
    '/api/skills/:id',
    { schema: { params: workPath, body: skillWriteSchema, response: { 200: skillVersionSchema } } },
    async (request) =>
      saveSkill(db, (await runtime.admin(request)).user.id, request.body, request.params.id),
  );
  app.get(
    '/api/skills/style/profiles',
    { schema: { querystring: emptyRequest, response: { 200: z.array(styleProfileSchema) } } },
    async (request) => listStyleProfiles(db, (await runtime.admin(request)).user.id),
  );
  app.post(
    '/api/skills/style/preview',
    { schema: { body: styleRequestSchema, response: { 200: styleProfileSchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      await runtime.rateLimit(`style-preview:${user.id}`, 5);
      return previewStyle({
        database: db,
        userId: user.id,
        input: request.body,
        getSettings: () => runtime.settings,
        router: services.router,
      });
    },
  );
  app.post(
    '/api/skills/style/:id/accept',
    { schema: { params: workPath, body: emptyRequest, response: { 200: skillVersionSchema } } },
    async (request) => acceptStyle(db, (await runtime.admin(request)).user.id, request.params.id),
  );
}
