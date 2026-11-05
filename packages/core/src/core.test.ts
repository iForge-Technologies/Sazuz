import { describe, expect, it } from 'vitest';
import { SecretRedactor } from '@sazuz/vault';
import { createLogger } from './logger.js';
import { createWorkerId, workerIdSchema } from './ids.js';
import { SazuzError } from './errors.js';
import { healthSchema } from './health.js';

describe('shared operational foundations', () => {
  it('creates unique, prefixed ULIDs', () => {
    const ids = Array.from({ length: 100 }, () => createWorkerId());
    expect(new Set(ids).size).toBe(100);
    expect(ids.every((id) => workerIdSchema.safeParse(id).success)).toBe(true);
    expect(workerIdSchema.safeParse('../worker').success).toBe(false);
  });

  it('keeps errors typed without exposing an underlying exception', () => {
    const error = new SazuzError('DB_UNAVAILABLE', 'Database unavailable.');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('DB_UNAVAILABLE');
    expect(error.message).toBe('Database unavailable.');
  });

  it('never writes a resolved canary secret to logs or model-bound output', () => {
    const canary = 'canary/secret+value?phase-zero';
    const redactor = new SecretRedactor();
    redactor.register(canary);
    const lines: string[] = [];
    const logger = createLogger('test', redactor, {
      write: (line) => {
        lines.push(line);
      },
    });
    logger.info({ nested: { value: canary } }, 'tool output: %s', canary);
    logger.error({ err: new Error(`failed using ${canary}`) }, 'request failed');
    logger.child({ context: canary }).info('child');
    const modelContext = JSON.stringify(
      redactor.redact({ observations: [canary, encodeURIComponent(canary)] }),
    );
    expect(lines).toHaveLength(3);
    expect(lines.join('')).not.toContain(canary);
    expect(modelContext).not.toContain(canary);
    expect(modelContext).not.toContain(encodeURIComponent(canary));
    expect(lines.join('')).toContain('request failed');
  });

  it('rejects contradictory readiness at the shared HTTP boundary', () => {
    const response = {
      status: 'ok',
      checkedAt: new Date().toISOString(),
      services: {
        database: { status: 'ok', latencyMs: 1 },
        worker: { status: 'ok', activeCount: 1, lastSeenAt: new Date().toISOString() },
      },
    };
    expect(healthSchema.safeParse(response).success).toBe(true);
    expect(
      healthSchema.safeParse({
        ...response,
        services: { ...response.services, database: { status: 'error', latencyMs: 0 } },
      }).success,
    ).toBe(false);
    expect(
      healthSchema.safeParse({
        ...response,
        services: { ...response.services, worker: { ...response.services.worker, activeCount: 0 } },
      }).success,
    ).toBe(false);
  });
});
