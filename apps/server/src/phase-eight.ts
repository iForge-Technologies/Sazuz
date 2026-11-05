import { z } from 'zod';
import {
  workflowWriteSchema,
  workflowReviewSchema,
  workflowSchema,
  workflowRunInputSchema,
  workflowRunSchema,
  workflowEventSchema,
  workflowDraftInputSchema,
  workflowDraftSchema,
} from '@sazuz/core/workflows';
import {
  getWorkflow,
  listWorkflows,
  saveWorkflow,
  reviewWorkflow,
  runWorkflow,
  getWorkflowRun,
  listWorkflowRuns,
  workflowHistory,
  signalWorkflow,
  generateWorkflowDraft,
  listWorkflowDrafts,
} from '@sazuz/workflows';
import { workId } from '@sazuz/core/work';
import { getAgent, listAgents } from '@sazuz/orchestrator';
import type { ModelRouter } from '@sazuz/llm';
import type { ToolRegistry } from '@sazuz/tools';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { workPath, emptyRequest } from './phase-three-shared.js';
import { createPhaseThreeServices } from './phase-three.js';

export function registerPhaseEight(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  services: {
    router: Pick<ModelRouter, 'generateObject'>;
    tools: ToolRegistry;
  } = createPhaseThreeServices(runtime),
) {
  const { database } = runtime;
  app.get(
    '/api/workflows/drafts',
    {
      schema: {
        querystring: z.strictObject({ projectId: workId }),
        response: { 200: z.array(workflowDraftSchema) },
      },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      return listWorkflowDrafts(database, user.id, request.query.projectId);
    },
  );
  app.post(
    '/api/workflows/drafts',
    {
      schema: { body: workflowDraftInputSchema, response: { 200: workflowDraftSchema } },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      await runtime.rateLimit(`workflow-draft:${user.id}`, 10);
      return generateWorkflowDraft({
        database,
        userId: user.id,
        input: request.body,
        getSettings: () => runtime.settings,
        router: services.router,
        catalogue: async () => {
          const agents = await Promise.all(
            (await listAgents(database, user.id))
              .filter((agent) => agent.enabled)
              .map(async (agent) => {
                const { definition } = await getAgent(database, user.id, agent.id);
                return {
                  role: agent.role,
                  tools: definition.tools,
                  accounts: definition.identity.connector_accounts,
                };
              }),
          );
          return {
            agents,
            tools: services.tools
              .list()
              .filter((tool) =>
                agents.some((agent) =>
                  agent.tools.some(
                    (pattern) =>
                      pattern === '*' ||
                      pattern === tool.name ||
                      (pattern.endsWith('.*') && tool.name.startsWith(pattern.slice(0, -1))),
                  ),
                ),
              ),
            accounts: runtime.settings.connectors.value.accounts.map((account) => ({
              id: account.id,
              kind: account.kind,
              provider: account.provider,
              scopes: account.scopes,
              mode: account.mode,
            })),
            workflows: (await listWorkflows(database, user.id))
              .filter(
                (workflow) =>
                  workflow.projectId === request.body.projectId && workflow.activeRevision !== null,
              )
              .map((workflow) => ({
                id: workflow.id,
                revision: workflow.activeRevision,
                name: workflow.definition.name,
              })),
          };
        },
      });
    },
  );
  app.get(
    '/api/workflows',
    { schema: { querystring: emptyRequest, response: { 200: z.array(workflowSchema) } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      return listWorkflows(database, user.id);
    },
  );
  app.post(
    '/api/workflows',
    { schema: { body: workflowWriteSchema, response: { 200: workflowSchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      return saveWorkflow(database, user.id, null, request.body);
    },
  );
  app.get(
    '/api/workflows/:id',
    {
      schema: {
        params: workPath,
        querystring: z.strictObject({ revision: z.coerce.number().int().positive().optional() }),
        response: { 200: workflowSchema },
      },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      return getWorkflow(database, user.id, request.params.id, request.query.revision);
    },
  );
  app.put(
    '/api/workflows/:id',
    { schema: { params: workPath, body: workflowWriteSchema, response: { 200: workflowSchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      return saveWorkflow(database, user.id, request.params.id, request.body);
    },
  );
  app.get(
    '/api/workflows/:id/versions',
    {
      schema: {
        params: workPath,
        querystring: emptyRequest,
        response: {
          200: z.array(
            z.strictObject({
              revision: z.number().int().positive(),
              reviewed: z.boolean(),
              createdAt: z.iso.datetime(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      return workflowHistory(database, user.id, request.params.id);
    },
  );
  app.post(
    '/api/workflows/:id/review',
    { schema: { params: workPath, body: workflowReviewSchema, response: { 200: workflowSchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      return reviewWorkflow(database, user.id, request.params.id, request.body, runtime.settings);
    },
  );
  app.get(
    '/api/workflows/:id/runs',
    {
      schema: {
        params: workPath,
        querystring: emptyRequest,
        response: { 200: z.array(workflowRunSchema) },
      },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      return listWorkflowRuns(database, user.id, request.params.id);
    },
  );
  app.post(
    '/api/workflows/:id/runs',
    {
      schema: {
        params: workPath,
        body: workflowRunInputSchema,
        response: { 200: workflowRunSchema },
      },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      await runtime.rateLimit(`workflow-run:${user.id}`, 30);
      return runWorkflow(database, user.id, request.params.id, request.body, runtime.settings);
    },
  );
  app.get(
    '/api/workflows/runs/:id',
    {
      schema: { params: workPath, querystring: emptyRequest, response: { 200: workflowRunSchema } },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      return getWorkflowRun(database, user.id, request.params.id);
    },
  );
  app.post(
    '/api/workflows/runs/:id/events',
    {
      schema: { params: workPath, body: workflowEventSchema, response: { 200: workflowRunSchema } },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      return signalWorkflow(database, user.id, request.params.id, request.body);
    },
  );
}
