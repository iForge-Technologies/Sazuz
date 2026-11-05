import { z } from 'zod';
import { workId } from './work';
import { agentRoleSchema } from './agents';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const terms = z.array(z.string().min(1).max(100)).min(1).max(256);
export const proposalFingerprintSchema = z
  .strictObject({
    kind: z.enum(['graph', 'sequential']),
    agents: z
      .array(agentRoleSchema.exclude(['cos', 'auditor']))
      .min(1)
      .max(24),
    dependencies: z
      .array(z.array(z.number().int().min(0).max(23)).max(24))
      .min(1)
      .max(24),
    mission: terms.min(3),
    goals: z.array(terms).min(1).max(24),
    acceptance: z.array(z.array(terms).max(10)).min(1).max(24),
    checkpoints: z.array(terms).max(10),
  })
  .refine(
    (value) =>
      value.agents.length === value.dependencies.length &&
      value.agents.length === value.goals.length &&
      value.agents.length === value.acceptance.length,
  );
export type ProposalFingerprint = z.infer<typeof proposalFingerprintSchema>;
export const proposalSourceSchema = z.strictObject({
  missionId: workId,
  runId: workId,
  planRevision: z.number().int().positive().nullable(),
  planHash: digest,
  goalHash: digest,
  privateOnly: z.boolean(),
});
export const proposalSourcesSchema = z
  .array(proposalSourceSchema)
  .length(3)
  .refine(
    (sources) =>
      new Set(sources.map((source) => source.missionId)).size === 3 &&
      new Set(sources.map((source) => source.runId)).size === 3,
  );
export const skillProposalSchema = z.strictObject({
  id: workId,
  projectId: workId,
  status: z.enum(['proposed', 'accepted', 'rejected']),
  markdown: z.string().min(1).max(24000),
  sources: proposalSourcesSchema,
  planSignature: digest,
  privateOnly: z.boolean(),
  skillId: workId.nullable(),
  revision: z.number().int().positive().nullable(),
  createdAt: z.iso.datetime(),
});
export type SkillProposal = z.infer<typeof skillProposalSchema>;
export const proposalQuerySchema = z.strictObject({ projectId: workId });
export const proposalDecisionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('reject') }),
  z.strictObject({
    action: z.literal('accept'),
    markdown: z.string().min(1).max(24000),
    enabled: z.boolean().default(true),
    privateOnly: z.boolean().default(true),
  }),
]);
