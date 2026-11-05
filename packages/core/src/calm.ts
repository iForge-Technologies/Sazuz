import { z } from 'zod';
import { workId } from './work';

export const notificationSignalsSchema = z.strictObject({
  sender: z.email().max(320).optional(),
  deadlineAt: z.iso.datetime().nullable().optional(),
  moneyInvolved: z.boolean().optional(),
  securityAlert: z.boolean().optional(),
  explicitUrgent: z.boolean().optional(),
  critical: z.boolean().optional(),
});
export const notificationEvidenceSchema = z.strictObject({
  score: z.number().int().min(0).max(100),
  source: z.string().max(160),
  reasons: z.array(z.string().max(400)).max(10),
  model: z.enum(['rules', 'classified', 'fallback']),
  bias: z.number().int().min(-40).max(40),
});
export const notificationFeedbackInputSchema = z.strictObject({
  requestId: z.uuid(),
  kind: z.enum(['not_important', 'sooner']),
});
export const notificationFeedbackSchema = z.strictObject({
  notificationId: workId,
  kind: notificationFeedbackInputSchema.shape.kind,
  bias: z.number().int().min(-40).max(40),
  settingsVersion: z.number().int().positive(),
});
