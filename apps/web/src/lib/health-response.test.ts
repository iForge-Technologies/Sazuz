import type { Health } from '@sazuz/core/health';
import { describe, expect, it } from 'vitest';

import { HealthRequestError, parseHealthResponse } from './health-response';

const healthy: Health = {
  status: 'ok',
  checkedAt: '2026-11-03T12:00:00.000Z',
  services: {
    database: { status: 'ok', latencyMs: 2.4 },
    worker: { status: 'ok', activeCount: 1, lastSeenAt: '2026-11-03T11:59:59.000Z' },
  },
};

describe('health response boundary', () => {
  it('accepts verified healthy and degraded results', () => {
    expect(parseHealthResponse(200, healthy)).toEqual(healthy);
    const degraded: Health = {
      ...healthy,
      status: 'degraded',
      services: {
        ...healthy.services,
        worker: { status: 'missing', activeCount: 0, lastSeenAt: null },
      },
    };
    expect(parseHealthResponse(503, degraded)).toEqual(degraded);
  });

  it('rejects status codes that contradict the service result', () => {
    expect(() => parseHealthResponse(503, healthy)).toThrow(HealthRequestError);
  });

  it('rejects an overall success when a dependency is unhealthy', () => {
    const contradictory = {
      ...healthy,
      services: {
        ...healthy.services,
        worker: { status: 'missing', activeCount: 0, lastSeenAt: null },
      },
    };
    expect(() => parseHealthResponse(200, contradictory)).toThrow(
      new HealthRequestError('invalid-response'),
    );
  });

  it('distinguishes unreachable services from invalid responses', () => {
    expect(() => parseHealthResponse(503, { error: { code: 'HEALTH_UNAVAILABLE' } })).toThrow(
      new HealthRequestError('unavailable'),
    );
    expect(() => parseHealthResponse(200, { status: 'ok' })).toThrow(
      new HealthRequestError('invalid-response'),
    );
    expect(() => parseHealthResponse(502, healthy)).toThrow(new HealthRequestError('unavailable'));
  });

  it('does not include untrusted payload values in errors', () => {
    expect(() => parseHealthResponse(200, { error: 'secret-canary-value' })).toThrow(
      'The health response could not be verified.',
    );
  });
});
