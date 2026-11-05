import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { projects, type Database } from '@sazuz/db';
import { chunkSchema, knowledgeSearchResultSchema } from '@sazuz/core/knowledge';
import { defineTool, type ToolContext } from '@sazuz/tools';
import type { EmbedBatch } from './indexing.js';
import { readChunk } from './sources.js';
import { searchKnowledge } from './retrieval.js';
import { MemoryError } from './errors.js';

export type ToolEmbeddings = (
  context: Pick<ToolContext, 'runId' | 'projectId' | 'agentId' | 'signal'> & {
    privateOnly?: boolean;
  },
) => EmbedBatch;
export function createKnowledgeTools(db: Database, embedding?: ToolEmbeddings) {
  async function owner(id: string) {
    const [project] = await db.orm.select().from(projects).where(eq(projects.id, id));
    if (!project) throw new MemoryError('SOURCE_NOT_FOUND');
    return project.userId;
  }
  return [
    defineTool({
      name: 'kb.search',
      description:
        'Search this project’s knowledge. Cite returned chunks exactly as [kb:chunk_id]; do not invent citations.',
      effect: 'read',
      scope: 'internal',
      untrusted: true,
      input: z.strictObject({
        query: z.string().min(1).max(2000),
        tokenBudget: z.number().int().min(100).max(4000).default(2000),
      }),
      output: knowledgeSearchResultSchema,
      run: async (context, args) =>
        searchKnowledge(
          db,
          await owner(context.projectId),
          { ...args, projectId: context.projectId },
          context.modelFree ? undefined : embedding?.(context),
        ),
    }),
    defineTool({
      name: 'kb.read',
      description: 'Read a source chunk in this project by its citation ID.',
      effect: 'read',
      scope: 'internal',
      untrusted: true,
      input: z.strictObject({ id: z.string().regex(/^chk_[0-9A-HJKMNP-TV-Z]{26}$/) }),
      output: chunkSchema,
      run: async (context, args) =>
        readChunk(db, await owner(context.projectId), args.id, context.projectId),
    }),
  ];
}
