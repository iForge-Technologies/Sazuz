import { createECDH, randomBytes } from 'node:crypto';
import { secretRedactor } from '@sazuz/vault';
import { z } from 'zod';
import { ConfigError } from './errors.js';
import {
  preparePrivateSecretDirectory,
  readPrivateFiles,
  removePrivateFile,
  writePrivateFileOnce,
} from './private-files.js';

const names = ['session.key', 'machine.key', 'operator.key', 'vapid.key'] as const;
const keySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine((value) => Buffer.from(value, 'base64url').toString('base64url') === value);
export async function ensurePlumbing(dataDir: string) {
  await preparePrivateSecretDirectory(dataDir);
  const existing = await readPrivateFiles(
    dataDir,
    names.map((name) => ({ name, maxBytes: 44, optional: true })),
  );
  for (const name of names) {
    if (!existing.has(name))
      await writePrivateFileOnce(dataDir, name, Buffer.from(randomBytes(32).toString('base64url')));
  }
  return readPlumbing(dataDir);
}
export async function readPlumbing(dataDir: string) {
  const files = await readPrivateFiles(
    dataDir,
    names.map((name) => ({ name, maxBytes: 44 })),
  );
  const values = names.map((name) => {
    const parsed = keySchema.safeParse(files.get(name)?.toString('utf8').trim());
    if (!parsed.success) throw new ConfigError('PLUMBING_SECRET_INVALID');
    secretRedactor.register(parsed.data);
    return parsed.data;
  });
  const vapid = createECDH('prime256v1');
  vapid.setPrivateKey(Buffer.from(values[3]!, 'base64url'));
  return {
    sessionKey: values[0]!,
    machineKey: Buffer.from(values[1]!, 'base64url'),
    operatorKey: values[2]!,
    vapidPublicKey: vapid.getPublicKey().toString('base64url'),
  };
}
/** Workers need the operator authentication key, not the vault machine or session keys. */
export async function readOperatorKey(dataDir: string): Promise<string> {
  const files = await readPrivateFiles(dataDir, [{ name: 'operator.key', maxBytes: 44 }]);
  const parsed = keySchema.safeParse(files.get('operator.key')?.toString('utf8').trim());
  if (!parsed.success) throw new ConfigError('PLUMBING_SECRET_INVALID');
  secretRedactor.register(parsed.data);
  return parsed.data;
}
export async function ensureSetupToken(dataDir: string): Promise<string> {
  await preparePrivateSecretDirectory(dataDir);
  const files = await readPrivateFiles(dataDir, [
    { name: 'setup-token', maxBytes: 44, optional: true },
  ]);
  if (!files.has('setup-token'))
    await writePrivateFileOnce(
      dataDir,
      'setup-token',
      Buffer.from(randomBytes(32).toString('base64url')),
    );
  const next = await readPrivateFiles(dataDir, [{ name: 'setup-token', maxBytes: 44 }]);
  const value = keySchema.parse(next.get('setup-token')?.toString('utf8').trim());
  secretRedactor.register(value);
  return value;
}
export const deleteSetupToken = (dataDir: string) => removePrivateFile(dataDir, 'setup-token');
