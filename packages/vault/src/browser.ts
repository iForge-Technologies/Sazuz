import { hkdfSync } from 'node:crypto';
import { z } from 'zod';
import { encryptedEnvelopeSchema, VaultError } from './contracts.js';
import { clearBytes, readyCrypto, seal, unseal } from './crypto.js';

export const browserBindingSchema = z.strictObject({
  sessionId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  callKey: z.string().min(1).max(256),
  site: z.string().max(300),
  purpose: z.enum(['state', 'secret', 'state-return']),
  nonce: z.uuid(),
  expiresAt: z.number().int().positive(),
});
export type BrowserBinding = z.infer<typeof browserBindingSchema>;
export const browserCapsuleSchema = z.strictObject({
  binding: browserBindingSchema,
  envelope: encryptedEnvelopeSchema,
});
function validate(binding: BrowserBinding) {
  browserBindingSchema.parse(binding);
  if (binding.expiresAt <= Date.now() || binding.expiresAt > Date.now() + 60000)
    throw new VaultError('VAULT_INVALID_INPUT');
}
function key(root: string) {
  return new Uint8Array(
    hkdfSync('sha256', Buffer.from(root, 'base64url'), 'sazuz', 'browser-capsule:v1', 32),
  );
}
function tuple(binding: BrowserBinding) {
  return [
    'sazuz-browser-v1',
    binding.sessionId,
    binding.runId,
    binding.callKey,
    binding.site,
    binding.purpose,
    binding.nonce,
    binding.expiresAt,
  ] as const;
}
/** Internal authenticated transport only. Never register whole storage-state documents as global secrets. */
export async function sealBrowserValue(root: string, binding: BrowserBinding, value: string) {
  validate(binding);
  if (Buffer.byteLength(value) > 65536) throw new VaultError('VAULT_INVALID_INPUT');
  await readyCrypto();
  const derived = key(root),
    plain = Buffer.from(value);
  try {
    return {
      binding: browserBindingSchema.parse(binding),
      envelope: seal(plain, derived, tuple(binding)),
    };
  } finally {
    clearBytes(derived, plain);
  }
}
export async function consumeBrowserValue<T>(
  root: string,
  expected: BrowserBinding,
  input: unknown,
  consume: (value: string) => Promise<T>,
): Promise<T> {
  const parsed = browserCapsuleSchema.parse(input);
  validate(parsed.binding);
  if (JSON.stringify(parsed.binding) !== JSON.stringify(browserBindingSchema.parse(expected)))
    throw new VaultError('VAULT_INVALID_INPUT');
  await readyCrypto();
  const derived = key(root);
  let plain: Uint8Array | undefined;
  try {
    plain = unseal(parsed.envelope, derived, tuple(parsed.binding));
    return await consume(Buffer.from(plain).toString('utf8'));
  } finally {
    clearBytes(derived, plain);
  }
}
