import { z } from 'zod';
import { projects, type Database } from '@sazuz/db';
import { eq } from 'drizzle-orm';
import { memoryKindSchema, memorySchema } from '@sazuz/core/memory';
import { defineTool } from '@sazuz/tools';
import { insertProposal, proposalReceipt } from './store.js';
import { MemoryError } from './errors.js';
import { hybridMemorySearch } from './retrieval.js';
import type { ToolEmbeddings } from './knowledge-tools.js';

export function createMemoryTools(db: Database, embedding?: ToolEmbeddings) {
  async function owner(projectId: string) {
    const [project] = await db.orm.select().from(projects).where(eq(projects.id, projectId));
    if (!project) throw new MemoryError('MEMORY_NOT_FOUND');
    return project.userId;
  }
  return [
    defineTool({
      name: 'memory.search',
      description:
        'Find accepted memories in the current project, global scope and your agent scope.',
      effect: 'read',
      scope: 'internal',
      untrusted: true,
      input: z.strictObject({
        query: z.string().max(2000),
        tokenBudget: z.number().int().min(100).max(3000).default(1200),
      }),
      output: z.array(memorySchema),
      privateOnly: (rows) => rows.some((row) => row.sensitivity === 'private'),
      run: async (context, args) =>
        (
          await hybridMemorySearch(
            db,
            await owner(context.projectId),
            {
              ...args,
              projectId: context.projectId,
              agentId: context.agentId,
            },
            context.modelFree ? undefined : embedding?.(context),
          )
        ).filter(
          (memory) =>
            context.memoryScopes === undefined || context.memoryScopes.includes(memory.scope),
        ),
    }),
    defineTool({
      name: 'memory.propose',
      description:
        'Propose a project fact or preference for human review. Never store credentials or grant permissions.',
      effect: 'write',
      scope: 'internal',
      untrusted: false,
      input: z.strictObject({
        kind: memoryKindSchema,
        content: z.string().trim().min(1).max(4000),
      }),
      output: z.strictObject({ id: z.string() }),
      run: async (context, args) =>
        db.orm.transaction(async (tx) =>
          insertProposal(
            tx,
            {
              userId: await owner(context.projectId),
              projectId: context.projectId,
              scope: 'project',
              ...args,
              sourceRunId: context.runId,
              status: 'proposed',
              sensitivity: 'private',
            },
            `tool:${context.idempotencyKey}`,
          ),
        ),
      verify: async (context) => {
        const result = await proposalReceipt(
          db,
          await owner(context.projectId),
          `tool:${context.idempotencyKey}`,
        );
        return result ? { status: 'done', result } : { status: 'not_done' };
      },
    }),
  ];
}
