import { z } from 'zod';
import {
  recordingSchema,
  loopCandidateSchema,
  learningInputSchema,
  learnedDraftSchema,
  learnedSaveSchema,
  learnedVersionSchema,
} from '@sazuz/core/learning';
import { listRecordings, recording } from '@sazuz/browser';
import {
  detectRecordingLoops,
  generateLearnedSkill,
  listLearningDrafts,
  saveLearnedSkill,
  learnedVersion,
} from '@sazuz/skills';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { createModelServices } from './phase-two.js';
import { emptyRequest, workPath } from './phase-three-shared.js';
import {
  learnedReplayInputSchema,
  learnedReplaySchema,
  learnedRepairSchema,
  learnedRevisionInputSchema,
  learnedRepairDecisionSchema,
} from '@sazuz/core/learning-replay';
import {
  replayHistory,
  startLearnedReplay,
  reviseLearnedSkill,
  listLearnedRepairs,
  decideLearnedRepair,
} from '@sazuz/skills';

export function registerLearning(app: Awaited<ReturnType<typeof createApp>>, runtime: PhaseOne) {
  const db = runtime.database;
  const services = createModelServices(runtime);
  app.post(
    '/api/skills/learned/:id/replays',
    {
      schema: {
        params: workPath,
        body: learnedReplayInputSchema,
        response: { 200: learnedReplaySchema },
      },
    },
    async (request) =>
      startLearnedReplay(
        db,
        (await runtime.admin(request)).user.id,
        request.params.id,
        request.body,
        runtime.settings,
      ),
  );
  app.get(
    '/api/skills/learned/:id/replays',
    {
      schema: {
        params: workPath,
        querystring: emptyRequest,
        response: { 200: z.array(learnedReplaySchema) },
      },
    },
    async (request) => replayHistory(db, (await runtime.admin(request)).user.id, request.params.id),
  );
  app.post(
    '/api/skills/learned/:id/revisions',
    {
      schema: {
        params: workPath,
        body: learnedRevisionInputSchema,
        response: { 200: learnedVersionSchema },
      },
    },
    async (request) =>
      reviseLearnedSkill(
        db,
        (await runtime.admin(request)).user.id,
        request.params.id,
        request.body,
      ),
  );
  app.get(
    '/api/skills/learned/:id/repairs',
    {
      schema: {
        params: workPath,
        querystring: emptyRequest,
        response: { 200: z.array(learnedRepairSchema) },
      },
    },
    async (request) =>
      listLearnedRepairs(db, (await runtime.admin(request)).user.id, request.params.id),
  );
  app.post(
    '/api/skills/patches/:id/decision',
    {
      schema: {
        params: workPath,
        body: learnedRepairDecisionSchema,
        response: { 200: learnedRepairSchema },
      },
    },
    async (request) =>
      decideLearnedRepair(
        db,
        (await runtime.admin(request)).user.id,
        request.params.id,
        request.body,
      ),
  );
  app.get(
    '/api/skills/recordings',
    { schema: { querystring: emptyRequest, response: { 200: z.array(recordingSchema) } } },
    async (request) => listRecordings(db, (await runtime.admin(request)).user.id),
  );
  app.get(
    '/api/skills/recordings/:id',
    {
      schema: {
        params: workPath,
        querystring: emptyRequest,
        response: {
          200: z.strictObject({ recording: recordingSchema, loops: z.array(loopCandidateSchema) }),
        },
      },
    },
    async (request) => {
      const value = await recording(db, (await runtime.admin(request)).user.id, request.params.id);
      return { recording: value, loops: detectRecordingLoops(value.events) };
    },
  );
  app.post(
    '/api/skills/recordings/:id/generate',
    {
      schema: {
        params: workPath,
        body: learningInputSchema,
        response: { 200: learnedDraftSchema },
      },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      await runtime.rateLimit(`learned-generate:${user.id}`, 5);
      return generateLearnedSkill({
        database: db,
        userId: user.id,
        recordingId: request.params.id,
        input: request.body,
        getSettings: () => runtime.settings,
        router: services.router,
      });
    },
  );
  app.get(
    '/api/skills/learned/drafts',
    { schema: { querystring: emptyRequest, response: { 200: z.array(learnedDraftSchema) } } },
    async (request) => listLearningDrafts(db, (await runtime.admin(request)).user.id),
  );
  app.post(
    '/api/skills/learned',
    { schema: { body: learnedSaveSchema, response: { 200: learnedVersionSchema } } },
    async (request) => saveLearnedSkill(db, (await runtime.admin(request)).user.id, request.body),
  );
  app.get(
    '/api/skills/learned/:id',
    {
      schema: {
        params: workPath,
        querystring: z.strictObject({ revision: z.coerce.number().int().positive().optional() }),
        response: { 200: learnedVersionSchema },
      },
    },
    async (request) =>
      learnedVersion(
        db,
        (await runtime.admin(request)).user.id,
        request.params.id,
        request.query.revision,
      ),
  );
}
