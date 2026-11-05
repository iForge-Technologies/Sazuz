import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { encryptedEnvelopeSchema, secretReferenceSchema, VaultError } from './contracts.js';
import { clearBytes, readyCrypto, seal, unseal } from './crypto.js';
import { secretRedactor } from './redaction.js';

export const executionRequestSchema = z.strictObject({
  workspaceId: z.string().min(1).max(128),
  workerId: z.string().regex(/^wrk_[0-9A-HJKMNP-TV-Z]{26}$/),
  runId: z
    .string()
    .regex(/^run_[0-9A-HJKMNP-TV-Z]{26}$/)
    .nullable(),
  claimKey: z.uuid().nullable(),
  scope: z.enum(['model', 'tool', 'trigger', 'channel', 'knowledge', 'notification']),
  executionId: z.string().min(1).max(256),
  reference: secretReferenceSchema.nullable(),
  nonce: z.uuid(),
  expiresAt: z.number().int().positive(),
});
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
export const executionCapsuleSchema = z.strictObject({
  request: executionRequestSchema,
  envelope: encryptedEnvelopeSchema,
});
export type ExecutionCapsule = z.infer<typeof executionCapsuleSchema>;
function key(root: string, workspaceId: string, purpose: 'auth' | 'capsule') {
  if (!/^[A-Za-z0-9_-]{43}$/.test(root)) throw new VaultError('VAULT_INVALID_INPUT');
  const bytes = Buffer.from(root, 'base64url');
  try {
    return new Uint8Array(
      hkdfSync('sha256', bytes, workspaceId, `sazuz:worker-execution:v1:${purpose}`, 32),
    );
  } finally {
    bytes.fill(0);
  }
}
function tuple(request: ExecutionRequest) {
  return [
    'sazuz-worker-v1',
    'POST',
    '/internal/execution',
    request.workspaceId,
    request.workerId,
    request.runId,
    request.claimKey,
    request.scope,
    request.executionId,
    request.reference,
    request.nonce,
    request.expiresAt,
  ] as const;
}
function validate(request: unknown, now: number) {
  const parsed = executionRequestSchema.safeParse(request);
  if (!parsed.success || parsed.data.expiresAt <= now || parsed.data.expiresAt > now + 15_000)
    throw new VaultError('VAULT_INVALID_INPUT');
  return parsed.data;
}
export function signExecutionRequest(root: string, request: ExecutionRequest): string {
  const parsed = executionRequestSchema.parse(request);
  const derived = key(root, parsed.workspaceId, 'auth');
  try {
    return createHmac('sha256', derived)
      .update(JSON.stringify(tuple(parsed)))
      .digest('hex');
  } finally {
    derived.fill(0);
  }
}
export function makeExecutionRequest(
  root: string,
  input: Omit<ExecutionRequest, 'nonce' | 'expiresAt'>,
  now = Date.now(),
) {
  const request = executionRequestSchema.parse({
    ...input,
    nonce: randomUUID(),
    expiresAt: now + 10_000,
  });
  return { request, signature: signExecutionRequest(root, request) };
}
export function verifyExecutionRequest(
  root: string,
  input: unknown,
  signature: unknown,
  now = Date.now(),
): ExecutionRequest {
  const request = validate(input, now);
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature))
    throw new VaultError('VAULT_INVALID_INPUT');
  if (
    !timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(signExecutionRequest(root, request), 'hex'),
    )
  )
    throw new VaultError('VAULT_INVALID_INPUT');
  return request;
}
/** Called inside Vault.withSecret; ciphertext is the only value leaving that callback. */
export async function sealExecutionSecret(
  root: string,
  request: ExecutionRequest,
  value: string,
  now = Date.now(),
): Promise<ExecutionCapsule> {
  validate(request, now);
  await readyCrypto();
  secretRedactor.register(value);
  const derived = key(root, request.workspaceId, 'capsule'),
    plaintext = Buffer.from(value, 'utf8');
  try {
    return { request, envelope: seal(plaintext, derived, tuple(request)) };
  } finally {
    clearBytes(derived, plaintext);
  }
}
/** The expected request prevents swapping capsules between workers, claims, calls or references. */
export async function consumeExecutionSecret<T>(
  root: string,
  expected: ExecutionRequest,
  input: unknown,
  consume: (secret: string) => Promise<T>,
  now = Date.now(),
): Promise<T> {
  const parsed = executionCapsuleSchema.safeParse(input);
  if (!parsed.success) throw new VaultError('VAULT_INVALID_INPUT');
  validate(parsed.data.request, now);
  if (JSON.stringify(tuple(expected)) !== JSON.stringify(tuple(parsed.data.request)))
    throw new VaultError('VAULT_INVALID_INPUT');
  await readyCrypto();
  const derived = key(root, expected.workspaceId, 'capsule');
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = unseal(parsed.data.envelope, derived, tuple(expected));
    const value = Buffer.from(plaintext).toString('utf8');
    secretRedactor.register(value);
    return await consume(value);
  } finally {
    clearBytes(derived, plaintext);
  }
}
