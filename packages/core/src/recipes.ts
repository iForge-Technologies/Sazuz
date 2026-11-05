import { z } from 'zod';
import { SazuzError } from './errors';
import { workId } from './work';
import {
  agentRoleSchema,
  missionLimitsSchema,
  recipePolicySchema,
  triggerConfigSchema,
} from './missions';
import { workflowDefinitionSchema } from './workflows';

export const recipeIdSchema = z.number().int().min(1).max(24);
export const recipeModeSchema = z.enum(['manual', 'cron', 'imap', 'rss', 'webhook']);
export const recipeScheduleSchema = z.union([
  z.strictObject({ kind: z.literal('manual') }),
  triggerConfigSchema,
]);
export const recipeTemplateSchema = z.strictObject({
  id: recipeIdSchema,
  slug: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  kind: z.enum(['mission', 'workflow']).default('mission'),
  eventContract: z.string().max(2000).default(''),
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(500),
  agent: agentRoleSchema,
  assignments: z
    .array(z.strictObject({ agent: agentRoleSchema, task: z.string().min(1).max(500) }))
    .min(1)
    .max(4),
  fields: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/),
        label: z.string().min(1).max(100),
        help: z.string().max(500),
        required: z.boolean(),
        default: z.string().max(4000),
      }),
    )
    .min(1)
    .max(8),
  modes: z.array(recipeModeSchema).min(1).max(5),
  defaultCron: z.string().max(100),
  policy: recipePolicySchema,
  instructions: z.string().min(1).max(6000),
  prerequisites: z.array(z.string().min(1).max(500)).max(12),
  approvalPoints: z.array(z.string().min(1).max(500)).max(12),
  limitations: z.array(z.string().min(1).max(500)).max(12),
});
export type RecipeTemplate = z.infer<typeof recipeTemplateSchema>;
export const recipePreviewInputSchema = z.strictObject({
  recipeId: recipeIdSchema,
  requestId: z.uuid(),
  projectId: workId,
  values: z
    .record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/), z.string().max(4000))
    .refine((value) => Object.keys(value).length <= 8 && JSON.stringify(value).length <= 7000),
  schedule: recipeScheduleSchema,
});
export type RecipePreviewInput = z.infer<typeof recipePreviewInputSchema>;
export const recipePreviewSchema = z.strictObject({
  recipeId: recipeIdSchema,
  templateVersion: z.string(),
  templateHash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string(),
  goal: z.string().min(1).max(16000),
  agent: agentRoleSchema,
  policy: recipePolicySchema,
  schedule: recipeScheduleSchema,
  occurrences: z.array(z.iso.datetime()).max(5),
  limits: missionLimitsSchema,
  prerequisites: z.array(z.string()),
  approvalPoints: z.array(z.string()),
  limitations: z.array(z.string()),
  workflow: workflowDefinitionSchema.nullable().default(null),
});
export const recipeInstallationSchema = recipePreviewSchema.extend({
  id: workId,
  projectId: workId,
  requestId: z.uuid(),
  expiresAt: z.iso.datetime(),
  installedAt: z.iso.datetime().nullable(),
  missionId: workId.nullable(),
  triggerId: workId.nullable(),
  workflowId: workId.nullable().default(null),
});
export type RecipeInstallation = z.infer<typeof recipeInstallationSchema>;

export class RecipeError extends SazuzError {
  constructor(
    code:
      | 'RECIPE_NOT_FOUND'
      | 'RECIPE_INVALID'
      | 'RECIPE_CONFLICT'
      | 'RECIPE_CONNECTOR'
      | 'RECIPE_UNAVAILABLE',
  ) {
    super(
      code,
      {
        RECIPE_NOT_FOUND: 'This recipe or installation is unavailable.',
        RECIPE_INVALID: 'Check the recipe inputs and schedule. Keep credentials in the vault.',
        RECIPE_CONFLICT: 'This preview changed or expired. Preview the recipe again.',
        RECIPE_CONNECTOR: 'Choose a configured IMAP account with email read access.',
        RECIPE_UNAVAILABLE: 'The packaged recipe templates could not be loaded.',
      }[code],
    );
  }
}
