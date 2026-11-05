import './validation';

import { healthSchema, type Health } from '@sazuz/core/health';
import { z } from 'zod';

export const healthUnavailableSchema = z.strictObject({
  error: z.strictObject({ code: z.literal('HEALTH_UNAVAILABLE') }),
});

export type HealthRequestErrorCode = 'unavailable' | 'invalid-response';

export class HealthRequestError extends Error {
  readonly code: HealthRequestErrorCode;

  constructor(code: HealthRequestErrorCode) {
    super(
      code === 'unavailable'
        ? 'The health service is unavailable.'
        : 'The health response could not be verified.',
    );
    this.name = 'HealthRequestError';
    this.code = code;
  }
}

export function parseHealthResponse(status: number, payload: unknown): Health {
  if (status !== 200 && status !== 503) {
    throw new HealthRequestError('unavailable');
  }
  if (status === 503 && healthUnavailableSchema.safeParse(payload).success) {
    throw new HealthRequestError('unavailable');
  }

  const health = healthSchema.safeParse(payload);
  if (!health.success || status !== (health.data.status === 'ok' ? 200 : 503)) {
    throw new HealthRequestError('invalid-response');
  }
  return health.data;
}
