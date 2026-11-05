import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  browserCommandSchema,
  browserObservationSchema,
  browserSessionId,
  BrowserError,
  browserImageSchema,
} from '@sazuz/core/browser';
import { browserCapsuleSchema } from '@sazuz/vault';
import { domainSchema } from '@sazuz/sandbox';

export const browserWorkerRequestSchema = z.strictObject({
  workerId: z.string().regex(/^wrk_[0-9A-HJKMNP-TV-Z]{26}$/),
  claimKey: z.uuid(),
  runId: z.string().regex(/^run_[0-9A-HJKMNP-TV-Z]{26}$/),
  callKey: z.string().max(256),
  command: browserCommandSchema,
  verify: z.boolean(),
  nonce: z.uuid(),
  expiresAt: z.number().int().positive(),
});
export const browserLaunchSchema = z.strictObject({
  sessionId: browserSessionId,
  runId: z.string().max(128),
  projectId: z.string().max(128),
  agentId: z.string().max(128),
  profileId: z.string().max(128),
  site: z.string().max(300),
  generation: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  domains: z.array(domainSchema).min(1).max(32),
  poolSize: z.number().int().min(1).max(10),
  screencastQuality: z.number().int().min(10).max(100),
});
export type BrowserLaunch = z.infer<typeof browserLaunchSchema>;
export const browserRpcSchema = z.strictObject({
  nonce: z.uuid(),
  expiresAt: z.number().int().positive(),
  mode: z.enum([
    'action',
    'verify',
    'state',
    'close',
    'take',
    'handback',
    'health',
    'image',
    'record',
  ]),
  recordingId: z
    .string()
    .regex(/^rec_[0-9A-HJKMNP-TV-Z]{26}$/)
    .optional(),
  sessionId: browserSessionId.optional(),
  callKey: z.string().max(256).optional(),
  command: browserCommandSchema.optional(),
  launch: browserLaunchSchema.optional(),
  capsule: browserCapsuleSchema.optional(),
  imageHandle: z.string().max(64).optional(),
});
export type BrowserRpc = z.infer<typeof browserRpcSchema>;
export const browserRpcResultSchema = z.strictObject({
  ready: z.boolean().optional(),
  status: z.enum(['done', 'not_done', 'unknown']).optional(),
  observation: browserObservationSchema.optional(),
  state: browserCapsuleSchema.optional(),
  image: browserImageSchema.optional(),
});
export type BrowserRpcResult = z.infer<typeof browserRpcResultSchema>;
export const browserStorageSchema = z.strictObject({
  cookies: z
    .array(
      z.strictObject({
        name: z.string().max(500),
        value: z.string().max(10000),
        domain: z.string().max(253),
        path: z.string().max(2000),
        expires: z.number().finite(),
        httpOnly: z.boolean(),
        secure: z.boolean(),
        sameSite: z.enum(['Strict', 'Lax', 'None']),
        partitionKey: z.string().max(1000).optional(),
      }),
    )
    .max(128),
  origins: z
    .array(
      z.strictObject({
        origin: z.string().max(300),
        localStorage: z
          .array(z.strictObject({ name: z.string().max(500), value: z.string().max(10000) }))
          .max(100),
      }),
    )
    .max(1),
});
export type BrowserStorage = z.infer<typeof browserStorageSchema>;
export const browserProfileStateSchema = z.strictObject({
  state: browserStorageSchema,
  redactions: z.array(z.string().min(1).max(8000)).max(256),
  opaque: z.boolean().default(false),
});
export function scopedStorage(value: unknown, site: string): BrowserStorage {
  const state = browserStorageSchema.parse(value);
  const host = new URL(site).hostname;
  if (
    state.cookies.some((cookie) => cookie.domain.replace(/^\./, '') !== host || !cookie.secure) ||
    state.origins.some((origin) => origin.origin !== site) ||
    Buffer.byteLength(JSON.stringify(state)) > 60000
  )
    throw new BrowserError('BROWSER_DENIED');
  return state;
}
export function browserHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function signBrowserMessage(
  key: string,
  purpose: 'worker' | 'service' | 'live' | 'worker-image',
  value: unknown,
) {
  const derived = createHmac('sha256', Buffer.from(key, 'base64url'))
    .update(`sazuz:browser:${purpose}:v1`)
    .digest();
  try {
    return createHmac('sha256', derived).update(JSON.stringify(value)).digest('hex');
  } finally {
    derived.fill(0);
  }
}
export function verifyBrowserMessage<T extends { expiresAt: number }>(
  key: string,
  purpose: 'worker' | 'service' | 'live' | 'worker-image',
  value: T,
  signature: unknown,
) {
  if (
    value.expiresAt <= Date.now() ||
    value.expiresAt > Date.now() + 60000 ||
    typeof signature !== 'string' ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    !timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(signBrowserMessage(key, purpose, value), 'hex'),
    )
  )
    throw new BrowserError('BROWSER_DENIED');
}
export function rpcMessage(input: Omit<BrowserRpc, 'nonce' | 'expiresAt'>): BrowserRpc {
  return browserRpcSchema.parse({ ...input, nonce: randomUUID(), expiresAt: Date.now() + 45000 });
}
export const browserLiveGrantSchema = z.strictObject({
  sessionId: browserSessionId,
  nonce: z.uuid(),
  expiresAt: z.number().int().positive(),
});
export const browserImageRequestSchema = browserLiveGrantSchema.extend({
  workerId: browserWorkerRequestSchema.shape.workerId,
  claimKey: z.uuid(),
  runId: browserWorkerRequestSchema.shape.runId,
  sourceCallKey: z.string().min(1).max(256),
  imageHandle: z.string().regex(/^bim_[a-f0-9]{32}$/),
});

export function browserSocketText(data: Buffer | ArrayBuffer | Buffer[]): string {
  return (
    Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
  ).toString('utf8');
}
