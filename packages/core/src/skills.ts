import { z } from 'zod';
import { workId } from './work';
import { styleSourcesSchema } from './style';

export const skillNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const skillManifestSchema = z.strictObject({
  name: skillNameSchema,
  description: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .regex(/^[^\r\n]+$/),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/)
    .max(40),
  inputs: z
    .strictObject({
      type: z.literal('object'),
      properties: z.record(z.string().min(1).max(100), z.json()),
      required: z.array(z.string().min(1).max(100)).max(30).optional(),
      additionalProperties: z.boolean().optional(),
    })
    .refine((value) => JSON.stringify(value).length <= 6000),
  tools: z
    .array(
      z
        .string()
        .regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/)
        .max(128),
    )
    .max(30),
  permissions: z.array(z.enum(['read', 'write', 'send', 'delete', 'spend', 'publish'])).max(6),
});
export type SkillManifest = z.infer<typeof skillManifestSchema>;
export const skillSummarySchema = z.strictObject({
  id: workId,
  name: skillNameSchema,
  description: z.string().max(240),
  revision: z.number().int().positive(),
  source: z.enum(['builtin', 'user', 'style', 'learned', 'proposed']),
  enabled: z.boolean(),
  privateOnly: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export const skillVersionSchema = skillSummarySchema.extend({
  markdown: z.string().max(24000),
  manifest: skillManifestSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SkillVersion = z.infer<typeof skillVersionSchema>;
/** Full selected skills are bounded here and remain inline instead of becoming artifact summaries. */
export function isSkillLoad(name: string, output: unknown): boolean {
  return name === 'skills.load' && skillVersionSchema.safeParse(output).success;
}
export const skillWriteSchema = z.strictObject({
  markdown: z.string().min(1).max(24000),
  expectedRevision: z.number().int().min(0),
  enabled: z.boolean().default(true),
  privateOnly: z.boolean().default(false),
});
export const skillLoadSchema = z.strictObject({
  name: skillNameSchema,
  revision: z.number().int().positive().optional(),
});
export const styleRequestSchema = z
  .strictObject({
    requestId: z.uuid(),
    samples: z.array(z.string().trim().min(20).max(6000)).min(1).max(3),
    privateOnly: z.boolean().default(true),
  })
  .refine((value) => value.samples.reduce((total, sample) => total + sample.length, 0) <= 12000);
export const styleAnalysisSchema = z.strictObject({
  traits: z.array(z.string().trim().min(1).max(400)).min(1).max(12),
  greeting: z.string().max(200),
  signOff: z.string().max(200),
  sampleDraft: z.string().min(1).max(2000),
});
export const styleProfileSchema = z.strictObject({
  id: workId,
  requestId: z.uuid(),
  status: z.enum(['generating', 'preview', 'accepted', 'failed']),
  markdown: z.string().max(24000).nullable(),
  sampleDraft: z.string().max(2000).nullable(),
  privateOnly: z.boolean(),
  projectId: workId.nullable().default(null),
  sources: styleSourcesSchema.default([]),
  errorCode: z.string().nullable(),
  skillId: workId.nullable(),
  revision: z.number().int().positive().nullable(),
  costUsd: z.number().nonnegative(),
  createdAt: z.iso.datetime(),
});
