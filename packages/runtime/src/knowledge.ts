import { missionContext, type Database } from '@sazuz/db';
import { billedEmbeddings, MemoryError, type ToolEmbeddings } from '@sazuz/memory';
import type { SettingsDocument } from '@sazuz/config/settings';
import type { EmbeddingRequest, EmbeddingResult } from '@sazuz/llm';
import type { ExecutionScope } from './broker.js';
import { durableCheckpointSchema } from './durable-contracts.js';
import { workflowNodeExecutionSchema, WorkflowError } from '@sazuz/core/workflows';

export function runEmbeddings(options: {
  database: Database;
  workerId: string;
  getSettings: () => SettingsDocument;
  embed: (scope: ExecutionScope, request: EmbeddingRequest) => Promise<EmbeddingResult>;
}): ToolEmbeddings {
  return (context) => async (target, texts, privateOnly) => {
    const mission = await missionContext(options.database, context.runId);
    if (
      !mission ||
      mission.run.workerId !== options.workerId ||
      !mission.run.claimKey ||
      mission.run.status !== 'running' ||
      mission.project.id !== context.projectId
    )
      throw new MemoryError('JOB_NOT_FOUND');
    const scope: ExecutionScope = {
      scope: 'model',
      runId: context.runId,
      claimKey: mission.run.claimKey,
      executionId: 'run',
    };
    if (workflowNodeExecutionSchema.safeParse(mission.run.workflowNode).data?.modelFree)
      throw new WorkflowError('WORKFLOW_MODEL_FREE');
    const checkpoint = mission.run.checkpoint
      ? durableCheckpointSchema.parse(mission.run.checkpoint)
      : null;
    return billedEmbeddings({
      database: options.database,
      userId: mission.project.userId,
      projectId: context.projectId,
      runId: context.runId,
      agentId: context.agentId,
      getSettings: options.getSettings,
      signal: context.signal,
      router: { embed: (request) => options.embed(scope, request) },
    })(
      target,
      texts,
      privateOnly || context.privateOnly === true || checkpoint?.loop.privateOnly === true,
    );
  };
}
