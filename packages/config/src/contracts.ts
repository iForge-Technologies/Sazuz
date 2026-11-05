import { z } from 'zod';
import {
  namespaceSchema,
  settingsDocumentSchema,
  settingsEntrySchema,
  teamSchema,
} from '@sazuz/config/settings';

export const vaultStatusSchema = z.strictObject({
  initialized: z.boolean(),
  locked: z.boolean(),
  mode: z.enum(['auto', 'strict']).nullable(),
  recoveryConfirmed: z.boolean(),
});
export const setupStatusSchema = z.strictObject({
  completed: z.boolean(),
  gateOpen: z.boolean(),
  authenticated: z.boolean(),
  currentStep: z.number().int().min(0).max(12),
  adminCreated: z.boolean(),
  vault: vaultStatusSchema,
  settings: settingsDocumentSchema.nullable(),
  team: teamSchema,
  csrfToken: z.string().min(32).nullable(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;
export const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine(
    (value) => /[a-z]/i.test(value) && /[^a-z]/i.test(value),
    'Use at least 12 characters with a letter and a number or symbol.',
  );
export const gateRequestSchema = z.strictObject({ token: z.string().min(1).max(256) });
export const adminRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  password: passwordSchema,
});
export const stepRequestSchema = z.strictObject({
  step: z.number().int().min(1).max(12),
  namespace: namespaceSchema.optional(),
  value: z.unknown().optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
  team: teamSchema.optional(),
});
export const settingRequestSchema = z.strictObject({
  value: z.unknown(),
  expectedVersion: z.number().int().nonnegative(),
});
export const settingResponseSchema = settingsEntrySchema.extend({ namespace: namespaceSchema });
export const recoveryResponseSchema = z.strictObject({
  recoveryKit: z.strictObject({ text: z.string(), confirmationHint: z.string() }),
  vault: vaultStatusSchema,
});
export const secretMetadataSchema = z.strictObject({
  id: z.string(),
  handle: z.string(),
  name: z.string(),
  masked: z.string(),
});
export const safeErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string() }),
});
