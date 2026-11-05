import { z } from 'zod';
import { workId } from './work';

export const sourceKindSchema = z.enum(['pdf', 'docx', 'md', 'html', 'url']);
export const sourceUploadSchema = z.strictObject({
  projectId: workId,
  requestId: z.uuid(),
  name: z.string().trim().min(1).max(160),
  kind: z.enum(['pdf', 'docx', 'md', 'html']),
  base64: z
    .string()
    .min(4)
    .max(11_184_812)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export const sourceUrlSchema = z.strictObject({
  projectId: workId,
  requestId: z.uuid(),
  name: z.string().trim().min(1).max(160),
  url: z
    .url()
    .max(2048)
    .refine((value) => {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash
      );
    }),
});
export const sourceSchema = z.strictObject({
  id: workId,
  projectId: workId,
  name: z.string(),
  kind: sourceKindSchema,
  url: z.string().nullable(),
  status: z.enum(['queued', 'ready', 'failed']),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  chunkCount: z.number().int().nonnegative(),
});
export type KnowledgeSource = z.infer<typeof sourceSchema>;
export const parsedSegmentSchema = z.strictObject({
  locator: z.string().min(1).max(300),
  text: z.string().min(1).max(1_000_000),
});
export const parsedDocumentSchema = z.array(parsedSegmentSchema).min(1).max(200);
export const chunkSchema = z.strictObject({
  id: workId,
  sourceId: workId,
  projectId: workId,
  sourceName: z.string(),
  sourceUrl: z.string().nullable(),
  locator: z.string(),
  text: z.string().max(12000),
  citation: z.string(),
  ordinal: z.number().int().nonnegative(),
});
export type KnowledgeChunk = z.infer<typeof chunkSchema>;
export const knowledgeSearchSchema = z.strictObject({
  projectId: workId,
  query: z.string().trim().min(1).max(2000),
  tokenBudget: z.number().int().min(100).max(4000).default(2000),
  limit: z.number().int().min(1).max(20).default(8),
});
export const knowledgeSearchResultSchema = z.strictObject({
  mode: z.enum(['hybrid', 'full-text']),
  generationId: workId.nullable(),
  notice: z.string().nullable(),
  matches: z.array(chunkSchema).max(20),
});
export const generationSchema = z.strictObject({
  id: workId,
  projectId: workId,
  providerId: z.string(),
  modelId: z.string(),
  status: z.enum(['building', 'active', 'retired', 'failed']),
  dimensions: z.number().int().positive().nullable(),
  createdAt: z.iso.datetime(),
});
export const reindexInputSchema = z.strictObject({ projectId: workId });
