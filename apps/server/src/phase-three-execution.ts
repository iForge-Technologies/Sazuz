import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  assertAccountPermission,
  connectorAccountSchema,
  connectorActions,
  googleProviders,
} from '@sazuz/connectors';
import {
  executionNonces,
  getControl,
  knowledgeJobs,
  embeddingGenerations,
  isWorkerHealthy,
  missions,
  modelCatalog,
  projects,
  readSettings,
  runs,
  toolCalls,
  triggers,
  valueHash,
  notifications,
  workflowRuns,
} from '@sazuz/db';
import { agentRoleSchema, triggerConfigSchema } from '@sazuz/core/missions';
import { knowledgeJobPayloadSchema } from '@sazuz/core/memory';
import { workflowNodeExecutionSchema } from '@sazuz/core/workflows';
import { agentDefinitions, durableCheckpointSchema } from '@sazuz/runtime';
import { acceptedActionReview, agentActionPermission, hasPinnedAgent } from '@sazuz/orchestrator';
import { mcpToolName } from '@sazuz/mcp/connections';
import { workflowAllows } from '@sazuz/workflows/s2a';
import {
  sealExecutionSecret,
  verifyExecutionRequest,
  type ExecutionRequest,
  type SecretReference,
} from '@sazuz/vault';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { RequestError } from './phase-one-errors.js';
import { emptyRequest, parseRequest } from './phase-three-shared.js';

const denied = () =>
  new RequestError('EXECUTION_DENIED', 403, 'This execution credential request is unavailable.');
const accountArgument = z.object({ accountId: z.string().min(1).max(128) });

/** Only ciphertext crosses this boundary; the root and vault master keys stay on their host. */
export function registerExecutionBroker(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
) {
  app.post('/internal/execution', async (request) => {
    parseRequest(emptyRequest, request.query);
    let execution: ExecutionRequest;
    try {
      execution = verifyExecutionRequest(
        runtime.plumbing.operatorKey,
        request.body,
        request.headers['x-sazuz-worker-signature'],
      );
    } catch {
      throw denied();
    }
    const installation = await runtime.state();
    if (
      execution.workspaceId !== installation.workspaceId ||
      !(await isWorkerHealthy(runtime.database, execution.workerId))
    )
      throw denied();
    if ((await runtime.vault.status()).locked)
      throw new RequestError('VAULT_LOCKED', 423, 'Unlock the vault before executing work.');
    if ((await getControl(runtime.database)).paused && execution.scope !== 'channel')
      throw denied();
    const settings = await readSettings(runtime.database);
    return runtime.database.orm.transaction(async (tx) => {
      const references = new Set<string>();
      if (execution.scope === 'model' || execution.scope === 'tool') {
        if (!execution.runId || !execution.claimKey) throw denied();
        const [run] = await tx
          .select()
          .from(runs)
          .where(eq(runs.id, execution.runId))
          .for('update');
        if (
          !run ||
          run.status !== 'running' ||
          run.workerId !== execution.workerId ||
          run.claimKey !== execution.claimKey
        )
          throw denied();
        const agent = agentRoleSchema.safeParse(run.agentId);
        if (!agent.success) throw denied();
        if (execution.scope === 'model') {
          if (execution.executionId !== 'run') throw denied();
          const [project] = await tx
            .select({ id: projects.id, privacy: projects.privacy })
            .from(projects)
            .innerJoin(missions, eq(missions.projectId, projects.id))
            .where(eq(missions.id, run.missionId));
          if (!project) throw denied();
          // The router can rank any enabled catalog entry, including its configured fallbacks.
          const catalog = await tx
            .select({ providerId: modelCatalog.providerId })
            .from(modelCatalog);
          const activeIndexes = await tx
            .select({ providerId: embeddingGenerations.providerId })
            .from(embeddingGenerations)
            .where(
              and(
                eq(embeddingGenerations.projectId, project.id),
                eq(embeddingGenerations.status, 'active'),
              ),
            );
          for (const provider of settings.providers.value.items) {
            if (
              !provider.enabled ||
              !provider.secretRef ||
              (!catalog.some((model) => model.providerId === provider.id) &&
                !activeIndexes.some((index) => index.providerId === provider.id))
            )
              continue;
            if (
              (project.privacy === 'private' ||
                settings.models.value.preset === 'private' ||
                durableCheckpointSchema.safeParse(run.checkpoint).data?.loop.privateOnly) &&
              provider.locality !== 'local'
            )
              continue;
            references.add(provider.secretRef);
          }
        } else {
          const [mission] = await tx
            .select({ source: missions.source })
            .from(missions)
            .where(eq(missions.id, run.missionId));
          if (!mission || mission.source === 'run-replay') throw denied();
          const checkpoint = durableCheckpointSchema.safeParse(run.checkpoint);
          if (!checkpoint.success || checkpoint.data.agentId !== run.agentId) throw denied();
          const loop = checkpoint.data.loop;
          const call = loop.pendingCalls[loop.nextCall];
          const expectedKey = `${run.id}:${loop.step}:${loop.nextCall}`;
          if (!call || execution.executionId !== expectedKey) throw denied();
          const [intent] = await tx
            .select()
            .from(toolCalls)
            .where(and(eq(toolCalls.runId, run.id), eq(toolCalls.idempotencyKey, expectedKey)));
          if (
            !intent ||
            !['intent', 'uncertain', 'retry_ready'].includes(intent.status) ||
            intent.toolName !== call.name ||
            intent.argsHash !== valueHash(call.args)
          )
            throw denied();
          const pinned = await hasPinnedAgent(runtime.database, run.id, agent.data);
          const [owner] = await tx
            .select({ userId: projects.userId })
            .from(projects)
            .innerJoin(missions, eq(missions.projectId, projects.id))
            .where(eq(missions.id, run.missionId));
          if (!owner) throw denied();
          if (
            pinned &&
            !(await agentActionPermission(
              runtime.database,
              owner.userId,
              run.id,
              agent.data,
              call.name,
              call.args,
              intent.effect,
              settings.connectors.value.accounts,
            ))
          )
            throw denied();
          const allow: readonly string[] = agentDefinitions[agent.data].allow;
          if (checkpoint.data.workflow && !workflowAllows(checkpoint.data.workflow, call.name))
            throw denied();
          const mcp = settings.advanced.value.mcp.find(
            (connection) =>
              connection.enabled &&
              connection.agents.includes(agent.data) &&
              connection.tools.some(
                (tool) => tool.enabled && mcpToolName(connection.id, tool.name) === call.name,
              ),
          );
          if (
            !pinned &&
            !mcp &&
            !allow.some((prefix) =>
              prefix.endsWith('.') ? call.name.startsWith(prefix) : call.name === prefix,
            )
          )
            throw denied();
          const action = connectorActions[call.name];
          const remoteEffect = mcp?.tools.find(
            (tool) => mcpToolName(mcp.id, tool.name) === call.name,
          )?.effect;
          const effect = remoteEffect
            ? remoteEffect === 'unknown'
              ? 'write'
              : remoteEffect
            : action?.permission.endsWith(':read')
              ? 'read'
              : action?.permission.endsWith(':send')
                ? 'send'
                : action?.permission.endsWith(':delete')
                  ? 'delete'
                  : 'write';
          if (
            intent.effect !== effect ||
            !(await acceptedActionReview(
              runtime.database,
              run.id,
              expectedKey,
              call,
              { effect, scope: 'external' },
              settings,
            ))
          )
            throw denied();
          if (mcp) {
            if (mcp.secretRef) references.add(mcp.secretRef);
          } else {
            const args = accountArgument.safeParse(call.args);
            if (!action || !args.success) throw denied();
            const accounts = settings.connectors.value.accounts.filter(
              (account) => account.id === args.data.accountId,
            );
            if (accounts.length !== 1) throw denied();
            const account = connectorAccountSchema.safeParse(accounts[0]);
            if (!account.success) throw denied();
            try {
              assertAccountPermission(account.data, action.provider, action.permission);
            } catch {
              throw denied();
            }
            if (account.data.secretRef) references.add(account.data.secretRef);
            if (
              account.data.options.oauthClientSecretRef &&
              [...googleProviders, 'microsoft-graph'].includes(action.provider)
            )
              references.add(account.data.options.oauthClientSecretRef);
          }
        }
      } else if (execution.scope === 'notification') {
        if (
          execution.runId !== null ||
          !execution.claimKey ||
          !settings.profile.value.priorityModel
        )
          throw denied();
        const [item] = await tx
          .select()
          .from(notifications)
          .where(eq(notifications.id, execution.executionId))
          .for('share');
        if (
          !item?.sourceRunId ||
          item.classificationStatus !== 'running' ||
          item.classificationClaim !== execution.claimKey ||
          item.classificationWorker !== execution.workerId ||
          !item.classificationAt ||
          Date.now() - item.classificationAt.getTime() > 15000
        )
          throw denied();
        const [source] = await tx
          .select({ run: runs, project: projects })
          .from(runs)
          .innerJoin(missions, eq(missions.id, runs.missionId))
          .innerJoin(projects, eq(projects.id, missions.projectId))
          .where(eq(runs.id, item.sourceRunId));
        if (
          !source ||
          source.project.id !== item.projectId ||
          source.project.userId !== item.userId ||
          !['completed', 'failed', 'budget_exceeded'].includes(source.run.status)
        )
          throw denied();
        const node = workflowNodeExecutionSchema.safeParse(source.run.workflowNode).data;
        const [workflow] = await tx
          .select()
          .from(workflowRuns)
          .where(eq(workflowRuns.runId, node?.workflowRunId ?? source.run.id));
        if (node?.modelFree || workflow?.modelFree) throw denied();
        const catalog = await tx.select({ providerId: modelCatalog.providerId }).from(modelCatalog);
        for (const provider of settings.providers.value.items) {
          if (
            !provider.enabled ||
            !provider.secretRef ||
            !catalog.some((model) => model.providerId === provider.id)
          )
            continue;
          if (
            (item.privateOnly ||
              source.project.privacy === 'private' ||
              settings.models.value.preset === 'private' ||
              durableCheckpointSchema.safeParse(source.run.checkpoint).data?.loop.privateOnly ||
              node?.privateOnly ||
              workflow?.privateOnly) &&
            provider.locality !== 'local'
          )
            continue;
          references.add(provider.secretRef);
        }
      } else if (execution.scope === 'knowledge') {
        if (execution.runId !== null || execution.claimKey === null) throw denied();
        const [job] = await tx
          .select()
          .from(knowledgeJobs)
          .where(eq(knowledgeJobs.id, execution.executionId))
          .for('share');
        if (
          !job ||
          job.status !== 'running' ||
          job.workerId !== execution.workerId ||
          job.claimKey !== execution.claimKey ||
          !knowledgeJobPayloadSchema.safeParse(job.payload).success
        )
          throw denied();
        const payload = knowledgeJobPayloadSchema.parse(job.payload);
        if (payload.kind === 'ingest') throw denied();
        if (payload.kind === 'reindex') {
          const [generation] = await tx
            .select()
            .from(embeddingGenerations)
            .where(eq(embeddingGenerations.id, payload.generationId));
          if (
            !generation ||
            generation.projectId !== job.projectId ||
            generation.providerId !== job.providerId ||
            generation.modelId !== job.modelId
          )
            throw denied();
        }
        const [project] = job.projectId
          ? await tx.select().from(projects).where(eq(projects.id, job.projectId))
          : [];
        if (job.projectId && (!project || project.userId !== job.userId)) throw denied();
        const catalog = await tx.select({ providerId: modelCatalog.providerId }).from(modelCatalog);
        for (const provider of settings.providers.value.items) {
          if (!provider.enabled || !provider.secretRef) continue;
          if (
            job.providerId
              ? provider.id !== job.providerId
              : !catalog.some((entry) => entry.providerId === provider.id)
          )
            continue;
          if (
            (project?.privacy === 'private' || settings.models.value.preset === 'private') &&
            provider.locality !== 'local'
          )
            continue;
          references.add(provider.secretRef);
        }
      } else {
        if (execution.runId !== null || execution.claimKey !== null) throw denied();
        if (execution.scope === 'channel') {
          if (execution.executionId !== 'telegram' || !settings.channels.value.telegramSecretRef)
            throw denied();
          references.add(settings.channels.value.telegramSecretRef);
        } else {
          const [trigger] = await tx
            .select()
            .from(triggers)
            .where(eq(triggers.id, execution.executionId))
            .for('share');
          if (!trigger?.enabled) throw denied();
          const config = triggerConfigSchema.safeParse(trigger.config);
          if (!config.success || config.data.kind !== 'imap') throw denied();
          const connectorId = config.data.connectorId;
          const matches = settings.connectors.value.accounts.filter(
            (account) => account.id === connectorId,
          );
          if (matches.length !== 1) throw denied();
          const account = connectorAccountSchema.safeParse(matches[0]);
          if (!account.success) throw denied();
          try {
            assertAccountPermission(account.data, 'imap-smtp', 'email:read');
          } catch {
            throw denied();
          }
          references.add(account.data.secretRef!);
        }
      }
      if (execution.reference !== null && !references.has(execution.reference)) throw denied();
      const accepted = await tx
        .insert(executionNonces)
        .values({ nonce: execution.nonce, expiresAt: new Date(execution.expiresAt) })
        .onConflictDoNothing()
        .returning();
      if (!accepted.length)
        throw new RequestError(
          'EXECUTION_REPLAYED',
          409,
          'This execution credential request has already been consumed.',
        );
      if (execution.reference === null) return { ready: true };
      return runtime.vault.withSecret(execution.reference as SecretReference, 'user', (value) =>
        sealExecutionSecret(runtime.plumbing.operatorKey, execution, value),
      );
    });
  });
}
