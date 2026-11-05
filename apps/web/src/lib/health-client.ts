import type { Health } from '@sazuz/core/health';

import { HealthRequestError, parseHealthResponse } from './health-response';

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(5_000);
    response = await fetch('/api/health', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new HealthRequestError('unavailable');
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HealthRequestError('invalid-response');
  }
  return parseHealthResponse(response.status, payload);
}
