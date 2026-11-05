import { z } from 'zod';
import { workId } from '@sazuz/core/work';
import { RequestError } from './phase-one-errors.js';

export const emptyRequest = z.strictObject({});
export const workPath = z.strictObject({ id: workId });
export const accountPath = z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) });

export function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new RequestError('INVALID_REQUEST', 400, 'Check the submitted fields.');
  return result.data;
}
