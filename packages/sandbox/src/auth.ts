import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { SandboxError } from '@sazuz/core/sandbox';
import { secretRedactor } from '@sazuz/vault';

export const domainSchema = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const grantSchema = z.strictObject({
  service: z.enum(['docker', 'egress', 'browser']),
  subject: z.string().min(1).max(160),
  projectId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(128),
  domains: z.array(domainSchema).max(32),
  expiresAt: z.number().int().positive(),
  nonce: z.uuid(),
  specHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type ServiceGrant = z.infer<typeof grantSchema>;
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function signature(key: string, service: string, value: string): Buffer {
  const purpose = createHmac('sha256', Buffer.from(key, 'base64url'))
    .update(`sazuz:phase5:${service}`)
    .digest();
  return createHmac('sha256', purpose).update(value).digest();
}
export function issueGrant(
  key: string,
  input: Omit<ServiceGrant, 'nonce'>,
  now = Date.now(),
): string {
  const grant = grantSchema.parse({ ...input, nonce: randomUUID() });
  if (grant.expiresAt <= now || grant.expiresAt > now + 3_660_000)
    throw new SandboxError('SANDBOX_INVALID');
  const body = Buffer.from(JSON.stringify(grant)).toString('base64url');
  const token = `${body}.${signature(key, grant.service, body).toString('base64url')}`;
  secretRedactor.register(token);
  return token;
}
export function verifyGrant(
  key: string,
  service: ServiceGrant['service'],
  value: unknown,
  now = Date.now(),
): ServiceGrant {
  if (typeof value !== 'string' || value.length > 16_384) throw new SandboxError('SANDBOX_DENIED');
  const parts = value.split('.');
  const expected = signature(key, service, parts[0] ?? '');
  const actual = Buffer.from(parts[1] ?? '', 'base64url');
  if (parts.length !== 2 || expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new SandboxError('SANDBOX_DENIED');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
  } catch {
    throw new SandboxError('SANDBOX_DENIED');
  }
  const result = grantSchema.safeParse(parsed);
  if (
    !result.success ||
    result.data.service !== service ||
    result.data.expiresAt <= now ||
    result.data.expiresAt > now + 3_660_000
  )
    throw new SandboxError('SANDBOX_DENIED');
  secretRedactor.register(value);
  return result.data;
}
