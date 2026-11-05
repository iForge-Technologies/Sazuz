import type { z } from 'zod';

import { VaultError, type VaultErrorCode } from './contracts.js';

export function parseBoundary<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: VaultErrorCode = 'VAULT_INVALID_INPUT',
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new VaultError(code);
  return parsed.data;
}

export async function storageCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    // Storage drivers can include credentials or submitted values in their exception details.
    throw new VaultError('VAULT_STORAGE_FAILED');
  }
}

export function requireCommit(result: boolean): void {
  if (typeof result !== 'boolean') throw new VaultError('VAULT_STORAGE_FAILED');
  if (!result) throw new VaultError('VAULT_CONFLICT');
}

/** Key operations, including asynchronous execution callbacks, finish before lock can clear buffers. */
export class VaultMutex {
  #tail = Promise.resolve();

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.#tail;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
