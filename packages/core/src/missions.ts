import { z } from 'zod';
import { workId } from './work';
import { agentMessageTypeSchema, graphViewSchema, blackboardEntrySchema } from './graphs';

import { agentRoleSchema } from './agents';
import { reviewRecordSchema } from './reviews';
import { notificationEvidenceSchema, notificationFeedbackInputSchema } from './calm';
export { agentRoleSchema } from './agents';
export const recipePolicySchema = z.enum(['read_only', 'draft_send', 'review_changes']);
export type AgentRole = z.infer<typeof agentRoleSchema>;
export const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'waiting_tasks',
  'paused',
  'budget_exceeded',
  'completed',
  'failed',
  'cancelled',
]);
export const missionLimitsSchema = z.strictObject({
  maxSteps: z.number().int().min(1).max(1000),
  maxCostUsd: z.number().finite().min(0).max(10000),
  maxWallTimeSeconds: z.number().int().min(1).max(86400),
});
export const missionInputSchema = z.strictObject({
  projectId: workId,
  title: z.string().trim().min(1).max(160).optional(),
  goal: z.string().trim().min(1).max(24000),
  agent: agentRoleSchema.default('cos'),
  requestId: z.uuid(),
});
export const runSchema = z.strictObject({
  id: workId,
  missionId: workId,
  agentId: agentRoleSchema,
  status: runStatusSchema,
  step: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  limits: missionLimitsSchema,
  tainted: z.boolean(),
  reason: z.string().nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const missionSchema = z.strictObject({
  id: workId,
  projectId: workId,
  threadId: workId,
  title: z.string(),
  goal: z.string(),
  agent: agentRoleSchema,
  recipePolicy: recipePolicySchema.nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  run: runSchema,
});
export const stepSchema = z.strictObject({
  id: workId,
  runId: workId,
  ordinal: z.number().int().nonnegative(),
  agentId: agentRoleSchema,
  kind: z.enum(['assistant', 'tool', 'status', 'plan']),
  content: z.string(),
  prompt: z.string().nullable().default(null),
  toolName: z.string().nullable(),
  toolArgs: z.json().nullable(),
  toolResult: z.json().nullable(),
  providerId: z.string().nullable(),
  modelId: z.string().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  createdAt: z.iso.datetime(),
});
export const approvalSchema = z.strictObject({
  id: workId,
  runId: workId,
  missionId: workId,
  projectId: workId,
  agentId: agentRoleSchema,
  toolName: z.string(),
  args: z.json(),
  effect: z.enum(['read', 'write', 'send', 'delete', 'spend', 'publish']),
  reason: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
  ruleId: z.string(),
  tainted: z.boolean(),
  kind: z.enum(['policy', 'uncertain']),
  status: z.enum(['pending', 'reviewing', 'approved', 'denied', 'expired', 'resolved']),
  version: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  note: z.string().nullable(),
});
export const approvalDecisionSchema = z
  .strictObject({
    version: z.number().int().positive(),
    action: z.enum(['approve', 'edit_approve', 'deny', 'confirm_done', 'confirm_not_done']),
    args: z.json().optional(),
    note: z.string().max(2000).default(''),
  })
  .superRefine((value, context) => {
    if (value.action === 'edit_approve' && value.args === undefined)
      context.addIssue({
        code: 'custom',
        message: 'Edited arguments are required.',
        path: ['args'],
      });
    if (value.action !== 'edit_approve' && value.args !== undefined)
      context.addIssue({
        code: 'custom',
        message: 'Arguments are only accepted with Edit and approve.',
        path: ['args'],
      });
  });
export const runControlSchema = z.strictObject({
  version: z.number().int().positive(),
  action: z.enum(['pause', 'resume', 'cancel', 'extend']),
  addCostUsd: z.number().finite().min(0).max(10000).default(0),
  addSteps: z.number().int().min(0).max(1000).default(0),
  addWallTimeSeconds: z.number().int().min(0).max(86400).default(0),
});
export const agentMessageSchema = z.strictObject({
  id: workId,
  from: z.union([agentRoleSchema, z.literal('user')]),
  to: z.union([agentRoleSchema, z.literal('user')]),
  type: agentMessageTypeSchema,
  taskId: z.string().nullable().default(null),
  payload: z.json().nullable().default(null),
  content: z.string(),
  createdAt: z.iso.datetime(),
});
export const missionDetailSchema = z.strictObject({
  mission: missionSchema,
  steps: z.array(stepSchema),
  approvals: z.array(approvalSchema),
  agentMessages: z.array(agentMessageSchema),
  graph: graphViewSchema.nullable().default(null),
  blackboard: z.array(blackboardEntrySchema).default([]),
  reviews: z.array(reviewRecordSchema).default([]),
});
export const controlSchema = z.strictObject({
  paused: z.boolean(),
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
});
export const controlInputSchema = z.strictObject({
  paused: z.boolean(),
  version: z.number().int().positive(),
});

const secretRef = z.string().regex(/^secret:\/\/sec_[0-9A-HJKMNP-TV-Z]{26}$/);
export const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });
const timezone = timezoneSchema;
export const cronTriggerConfigSchema = z.strictObject({
  kind: z.literal('cron'),
  expression: z.string().min(1).max(100),
  timezone,
});
export const imapTriggerConfigSchema = z.strictObject({
  kind: z.literal('imap'),
  connectorId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  mailbox: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\r\n\0]+$/)
    .default('INBOX'),
  pollIntervalSeconds: z.number().int().min(60).max(86400),
});
export const triggerConfigSchema = z.discriminatedUnion('kind', [
  cronTriggerConfigSchema,
  z.strictObject({ kind: z.literal('webhook'), secretRef }),
  z.strictObject({
    kind: z.literal('rss'),
    url: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash
        );
      }),
    pollIntervalSeconds: z.number().int().min(60).max(86400),
  }),
  imapTriggerConfigSchema,
]);
export const schedulePreviewSchema = z.strictObject({
  expression: z.string(),
  timezone,
  summary: z.string(),
  occurrences: z.array(z.iso.datetime()),
  reviewToken: z.string(),
  expiresAt: z.iso.datetime(),
});
export const schedulePreviewInputSchema = z.strictObject({
  text: z.string().min(1).max(1000).optional(),
  expression: z.string().min(1).max(100).optional(),
  timezone,
});
export const triggerInputSchema = z.strictObject({
  projectId: workId,
  name: z.string().trim().min(1).max(160),
  goal: z.string().trim().min(1).max(16000),
  agent: agentRoleSchema.default('cos'),
  config: triggerConfigSchema,
  enabled: z.boolean().default(true),
  reviewToken: z.string().max(512).optional(),
});
export const triggerSchema = z.strictObject({
  id: workId,
  projectId: workId,
  name: z.string(),
  goal: z.string(),
  agent: agentRoleSchema,
  recipePolicy: recipePolicySchema.nullable().default(null),
  config: triggerConfigSchema,
  enabled: z.boolean(),
  version: z.number().int().positive(),
  nextRunAt: z.iso.datetime().nullable(),
  lastRunAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
  webhookPath: z.string().nullable(),
});
export const triggerUpdateSchema = z.strictObject({
  version: z.number().int().positive(),
  enabled: z.boolean(),
});
export const notificationSchema = z.strictObject({
  id: workId,
  projectId: workId.nullable(),
  missionId: workId.nullable(),
  level: z.enum(['urgent', 'normal', 'low']),
  title: z.string(),
  body: z.string(),
  status: z.enum(['pending', 'deferred', 'digested', 'delivered', 'logged', 'uncertain']),
  dueAt: z.iso.datetime().nullable(),
  priorityEvidence: notificationEvidenceSchema.nullable().default(null),
  feedback: notificationFeedbackInputSchema.shape.kind.nullable().default(null),
  critical: z.boolean().default(false),
  createdAt: z.iso.datetime(),
});
export const digestSchema = z.strictObject({
  id: workId,
  title: z.string(),
  body: z.string(),
  itemCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  deliveryStatus: z.enum(['web', 'pending', 'delivered', 'uncertain']),
});
export const telegramBindingSchema = z.strictObject({
  id: workId,
  senderId: z.string(),
  chatId: z.string(),
  projectId: workId,
  createdAt: z.iso.datetime(),
});
export const telegramStatusSchema = z.strictObject({
  configured: z.boolean(),
  bindings: z.array(telegramBindingSchema),
  lastPollAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
});
export const telegramPairInputSchema = z.strictObject({ projectId: workId });
export const telegramPairSchema = z.strictObject({
  code: z.string(),
  expiresAt: z.iso.datetime(),
  command: z.string(),
});
export type Mission = z.infer<typeof missionSchema>;
export type Run = z.infer<typeof runSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type Trigger = z.infer<typeof triggerSchema>;
export type MissionInput = z.infer<typeof missionInputSchema>;
export type TriggerInput = z.infer<typeof triggerInputSchema>;
export type RunControl = z.infer<typeof runControlSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
