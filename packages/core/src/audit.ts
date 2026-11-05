import { z } from 'zod';

export const auditHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const auditAnchorSchema = z.strictObject({
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  hash: auditHashSchema,
});
export const auditPayloadSchema = z.tuple([
  z.string().min(1).max(128),
  z.string().min(1).max(128),
  z.string().min(1).max(256),
  z.string().max(2048),
  z.iso.datetime({ precision: 6 }),
]);
export const auditEntrySchema = z.strictObject({
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  payload: auditPayloadSchema,
  canonical: z.string().min(1).max(16384),
  previousHash: auditHashSchema,
  hash: auditHashSchema,
});
export const auditExportSchema = z.strictObject({
  format: z.literal('sazuz-audit-v1'),
  start: auditAnchorSchema,
  head: auditAnchorSchema,
  entries: z.array(auditEntrySchema).max(1000),
  complete: z.boolean(),
});
export type AuditExport = z.infer<typeof auditExportSchema>;
export const auditBundleSchema = z.strictObject({
  format: z.literal('sazuz-audit-bundle-v1'),
  head: auditAnchorSchema,
  pages: z.array(auditExportSchema).min(1).max(40),
});
export const auditPageSchema = z.strictObject({
  entries: z.array(auditEntrySchema).max(100),
  head: auditAnchorSchema,
});

export const passkeyIdSchema = z.string().regex(/^auth_[0-9A-HJKMNP-TV-Z]{26}$/);
export const passkeyListSchema = z
  .array(
    z.strictObject({
      id: passkeyIdSchema,
      name: z.string().max(120).nullable(),
      createdAt: z.iso.datetime(),
      backedUp: z.boolean(),
    }),
  )
  .max(10);
const binary = z
  .string()
  .min(1)
  .max(65536)
  .regex(/^[A-Za-z0-9_-]+$/);
const transport = z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);
const extensions = z.strictObject({
  credProps: z.strictObject({ rk: z.boolean().optional() }).optional(),
});
const credential = {
  id: binary,
  rawId: binary,
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: extensions,
};
export const passkeyRegistrationSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  response: z.strictObject({
    ...credential,
    response: z.strictObject({
      clientDataJSON: binary,
      attestationObject: binary,
      transports: z.array(transport).max(8).optional(),
      publicKeyAlgorithm: z.number().int().optional(),
      publicKey: binary.optional(),
      authenticatorData: binary.optional(),
    }),
  }),
});
export const passkeyAuthenticationSchema = z.strictObject({
  response: z.strictObject({
    ...credential,
    response: z.strictObject({
      clientDataJSON: binary,
      authenticatorData: binary,
      signature: binary,
      userHandle: binary.optional(),
    }),
  }),
});
const descriptor = z.strictObject({
  id: binary,
  type: z.literal('public-key'),
  transports: z.array(transport).max(8).optional(),
});
export const passkeyRegisterOptionsSchema = z.strictObject({
  challenge: binary,
  rp: z.strictObject({ id: z.string().min(1).max(253), name: z.string().max(120) }),
  user: z.strictObject({ id: binary, name: z.string().max(254), displayName: z.string().max(254) }),
  pubKeyCredParams: z
    .array(z.strictObject({ type: z.literal('public-key'), alg: z.number().int() }))
    .max(16),
  timeout: z.number().positive().max(300000),
  attestation: z.literal('none'),
  excludeCredentials: z.array(descriptor).max(10),
  authenticatorSelection: z.strictObject({
    residentKey: z.enum(['discouraged', 'preferred', 'required']),
    userVerification: z.literal('required'),
    requireResidentKey: z.boolean().optional(),
  }),
  extensions: z.strictObject({ credProps: z.boolean().optional() }).optional(),
  hints: z
    .array(z.enum(['security-key', 'client-device', 'hybrid']))
    .max(3)
    .optional(),
});
export const passkeyAuthenticateOptionsSchema = z.strictObject({
  challenge: binary,
  rpId: z.string().min(1).max(253),
  timeout: z.number().positive().max(300000),
  userVerification: z.literal('required'),
  allowCredentials: z.array(descriptor).max(10).optional(),
  extensions: extensions.optional(),
});
