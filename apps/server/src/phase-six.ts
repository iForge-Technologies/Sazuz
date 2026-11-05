import { z } from 'zod';
import {
  agentRevisionSchema,
  agentSummarySchema,
  agentWriteSchema,
  agentRollbackSchema,
} from '@sazuz/core/agents';
import {
  ensureAgents,
  getAgent,
  listAgents,
  agentHistory,
  saveAgent,
  rollbackAgent,
  replyToMission,
} from '@sazuz/orchestrator';
import {
  graphView,
  missionBlackboard,
  missionContext,
  runs,
  MissionError,
  projectReview,
  saveProjectReview,
  missionReviews,
} from '@sazuz/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { approvals, auditReviews, publicReview, valueHash } from '@sazuz/db';
import { graphViewSchema, blackboardEntrySchema, missionReplySchema } from '@sazuz/core/graphs';
import {
  projectReviewSchema,
  projectReviewUpdateSchema,
  reviewRecordSchema,
} from '@sazuz/core/reviews';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { emptyRequest, workPath } from './phase-three-shared.js';
const path = z.strictObject({ id: z.string().min(1).max(64) });
export function registerPhaseSix(app: Awaited<ReturnType<typeof createApp>>, runtime: PhaseOne) {
  const db = runtime.database;
  async function owner(request: Parameters<PhaseOne['admin']>[0]) {
    const { user } = await runtime.admin(request);
    await ensureAgents(db, user.id, runtime.settings.connectors.value.accounts);
    return user.id;
  }
  app.get(
    '/api/approvals/:id/review',
    {
      schema: {
        params: workPath,
        querystring: emptyRequest,
        response: { 200: reviewRecordSchema.nullable() },
      },
    },
    async (request) => {
      const userId = await owner(request);
      const [approval] = await db.orm
        .select()
        .from(approvals)
        .where(eq(approvals.id, request.params.id));
      if (!approval || !(await missionContext(db, approval.runId, userId)))
        throw new MissionError('MISSION_NOT_FOUND');
      const [review] = await db.orm
        .select()
        .from(auditReviews)
        .where(
          and(
            eq(auditReviews.runId, approval.runId),
            eq(auditReviews.sourceKey, approval.callKey),
            eq(
              auditReviews.subjectHash,
              valueHash({
                toolName: approval.toolName,
                effect: approval.effect,
                args: approval.args,
              }),
            ),
          ),
        )
        .orderBy(desc(auditReviews.createdAt))
        .limit(1);
      return review ? publicReview(review) : null;
    },
  );
  async function missionOwner(request: Parameters<PhaseOne['admin']>[0], id: string) {
    const userId = await owner(request);
    const [root] = await db.orm
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.missionId, id), sql`${runs.parentRunId} IS NULL`));
    if (!root || !(await missionContext(db, root.id, userId)))
      throw new MissionError('MISSION_NOT_FOUND');
    return userId;
  }
  app.get(
    '/api/projects/:id/review',
    {
      schema: {
        params: workPath,
        querystring: emptyRequest,
        response: { 200: projectReviewSchema },
      },
    },
    async (request) => projectReview(db, await owner(request), request.params.id),
  );
  app.put(
    '/api/projects/:id/review',
    {
      schema: {
        params: workPath,
        body: projectReviewUpdateSchema,
        response: { 200: projectReviewSchema },
      },
    },
    async (request) => saveProjectReview(db, await owner(request), request.params.id, request.body),
  );
  app.get(
    '/api/missions/:id/reviews',
    {
      schema: {
        params: workPath,
        querystring: emptyRequest,
        response: { 200: z.array(reviewRecordSchema) },
      },
    },
    async (request) => {
      await missionOwner(request, request.params.id);
      return missionReviews(db, request.params.id);
    },
  );
  app.get(
    '/api/missions/:id/graph',
    {
      schema: {
        params: workPath,
        querystring: emptyRequest,
        response: { 200: graphViewSchema.nullable() },
      },
    },
    async (request) =>
      graphView(db, await missionOwner(request, request.params.id), request.params.id),
  );
  app.get(
    '/api/missions/:id/blackboard',
    {
      schema: {
        params: workPath,
        querystring: emptyRequest,
        response: { 200: z.array(blackboardEntrySchema) },
      },
    },
    async (request) =>
      missionBlackboard(db, await missionOwner(request, request.params.id), request.params.id),
  );
  app.post(
    '/api/missions/:id/messages',
    {
      schema: {
        params: workPath,
        body: missionReplySchema,
        response: { 200: z.strictObject({ recorded: z.literal(true) }) },
      },
    },
    async (request) =>
      replyToMission(
        db,
        await missionOwner(request, request.params.id),
        request.params.id,
        request.body,
      ),
  );
  app.get(
    '/api/agents',
    { schema: { querystring: emptyRequest, response: { 200: z.array(agentSummarySchema) } } },
    async (request) => listAgents(db, await owner(request)),
  );
  app.get(
    '/api/agents/:id',
    {
      schema: {
        params: path,
        querystring: z.strictObject({ version: z.coerce.number().int().positive().optional() }),
        response: { 200: agentRevisionSchema },
      },
    },
    async (request) => getAgent(db, await owner(request), request.params.id, request.query.version),
  );
  app.get(
    '/api/agents/:id/versions',
    {
      schema: {
        params: path,
        querystring: emptyRequest,
        response: { 200: z.array(agentRevisionSchema) },
      },
    },
    async (request) => agentHistory(db, await owner(request), request.params.id),
  );
  app.put(
    '/api/agents/:id',
    { schema: { params: path, body: agentWriteSchema, response: { 200: agentRevisionSchema } } },
    async (request) =>
      saveAgent(
        db,
        await owner(request),
        request.params.id,
        request.body,
        runtime.settings.connectors.value.accounts,
      ),
  );
  app.post(
    '/api/agents/:id/rollback',
    { schema: { params: path, body: agentRollbackSchema, response: { 200: agentRevisionSchema } } },
    async (request) =>
      rollbackAgent(
        db,
        await owner(request),
        request.params.id,
        request.body.expectedVersion,
        request.body.version,
        runtime.settings.connectors.value.accounts,
      ),
  );
}
