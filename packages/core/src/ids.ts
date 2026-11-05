import { ulid } from 'ulid';
import { z } from 'zod';

export const workerIdSchema = z.string().regex(/^wrk_[0-9A-HJKMNP-TV-Z]{26}$/);

export function createWorkerId(): string {
  return workerIdSchema.parse(`wrk_${ulid()}`);
}
