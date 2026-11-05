import { randomBytes } from 'node:crypto';

import { secretRedactor } from '@sazuz/vault';
import { z } from 'zod';

import { ConfigError } from './errors.js';
import { validateDataDir } from './infra.js';
import {
  preparePrivateSecretDirectory,
  PrivateFileError,
  readPrivateFiles,
  writePrivateFileOnce,
} from './private-files.js';

const credentialSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}\n?$/)
  .transform((value) => value.replace(/\n$/, ''))
  .refine((value) => Buffer.from(value, 'base64url').toString('base64url') === value);

const initializers = new Map<string, Promise<string>>();

function safeFileError(error: unknown): ConfigError {
  if (error instanceof ConfigError) return error;
  if (error instanceof PrivateFileError) {
    if (error.code === 'MISSING') return new ConfigError('DATABASE_CREDENTIAL_MISSING');
    if (error.code === 'INVALID') return new ConfigError('DATABASE_CREDENTIAL_INVALID');
    if (error.code === 'UNSAFE') return new ConfigError('DATABASE_CREDENTIAL_UNSAFE');
  }
  return new ConfigError('DATABASE_CREDENTIAL_IO');
}

export function parseDatabaseCredential(value: Buffer): string {
  const parsed = credentialSchema.safeParse(value.toString('utf8'));
  if (!parsed.success) throw new ConfigError('DATABASE_CREDENTIAL_INVALID');
  secretRedactor.register(parsed.data);
  return parsed.data;
}

/** Consumers only read; a missing credential never causes automatic replacement. */
export async function readDatabasePassword(dataDir: string): Promise<string> {
  try {
    const files = await readPrivateFiles(validateDataDir(dataDir), [
      { name: 'db-password', maxBytes: 44 },
    ]);
    const value = files.get('db-password');
    if (value === undefined) throw new ConfigError('DATABASE_CREDENTIAL_MISSING');
    return parseDatabaseCredential(value);
  } catch (error) {
    throw safeFileError(error);
  }
}

async function initialize(dataDir: string): Promise<string> {
  try {
    await preparePrivateSecretDirectory(dataDir);
    const files = await readPrivateFiles(dataDir, [
      { name: 'db-password', maxBytes: 44, optional: true },
    ]);
    const existing = files.get('db-password');
    if (existing !== undefined) return parseDatabaseCredential(existing);
    await writePrivateFileOnce(
      dataDir,
      'db-password',
      Buffer.from(`${randomBytes(32).toString('base64url')}\n`),
    );
    return await readDatabasePassword(dataDir);
  } catch (error) {
    throw safeFileError(error);
  }
}

/** Cross-process publication is atomic; concurrent callers in one process share the permission work. */
export async function ensureDatabasePassword(dataDir: string): Promise<string> {
  const directory = validateDataDir(dataDir);
  const inProgress = initializers.get(directory);
  if (inProgress !== undefined) return inProgress;
  const result = initialize(directory);
  initializers.set(directory, result);
  try {
    return await result;
  } finally {
    if (initializers.get(directory) === result) initializers.delete(directory);
  }
}
