import { describe, expect, it, vi } from 'vitest';
import { createLogger, createWorkerId } from '@sazuz/core';
import { SecretRedactor } from '@sazuz/vault';
import { readInfraConfig } from '@sazuz/config';
import { createDatabase } from './client.js';
import { heartbeatSnapshotSchema, readHealth, snapshotToHealth } from './health.js';
import { recordHeartbeat, removeHeartbeat, isWorkerHealthy } from './heartbeats.js';

describe('database readiness', () => {
  const checkedAt = new Date('2026-11-03T00:00:00Z');
  it('normalizes PostgreSQL timestamp strings from Drizzle raw queries', () => {
    const result = heartbeatSnapshotSchema.parse({
      checkedAt: '2026-11-03 05:30:00+05:30',
      vectorReady: true,
      activeCount: 0,
      lastSeenAt: null,
    });
    expect(result.checkedAt.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(heartbeatSnapshotSchema.safeParse({ ...result, checkedAt: null }).success).toBe(false);
    expect(
      heartbeatSnapshotSchema.safeParse({ ...result, checkedAt: 'not-a-timestamp' }).success,
    ).toBe(false);
  });
  it('reports missing workers, fresh workers, and stale workers distinctly', () => {
    expect(
      snapshotToHealth({ checkedAt, vectorReady: true, activeCount: 0, lastSeenAt: null }, 2)
        .services.worker.status,
    ).toBe('missing');
    expect(
      snapshotToHealth({ checkedAt, vectorReady: true, activeCount: 2, lastSeenAt: checkedAt }, 2)
        .status,
    ).toBe('ok');
    expect(
      snapshotToHealth({ checkedAt, vectorReady: true, activeCount: 0, lastSeenAt: checkedAt }, 2)
        .services.worker.status,
    ).toBe('stale');
    expect(
      snapshotToHealth({ checkedAt, vectorReady: false, activeCount: 1, lastSeenAt: checkedAt }, 2)
        .services.database.status,
    ).toBe('error');
  });

  it('returns bounded safe failures and typed mutations when the driver fails', async () => {
    const logs: string[] = [];
    const logger = createLogger('db-test', new SecretRedactor(), {
      write: (line) => {
        logs.push(line);
      },
    });
    const db = await createDatabase(
      readInfraConfig({
        SAZUZ_DATABASE_URL: 'postgres://test:canary-secret@127.0.0.1:1/sazuz_test',
      }),
      logger,
    );
    const failure = new Error('raw driver canary-secret');
    vi.spyOn(db.orm, 'execute').mockRejectedValue(failure);
    vi.spyOn(db.orm, 'insert').mockImplementation(() => {
      throw failure;
    });
    vi.spyOn(db.orm, 'delete').mockImplementation(() => {
      throw failure;
    });
    vi.spyOn(db.orm, 'select').mockImplementation(() => {
      throw failure;
    });
    try {
      const health = await readHealth(db);
      expect(health.status).toBe('degraded');
      expect(health.services.worker.status).toBe('unavailable');
      expect(JSON.stringify(health)).not.toContain('canary');
      await expect(recordHeartbeat(db, createWorkerId())).rejects.toMatchObject({
        code: 'HEARTBEAT_FAILED',
      });
      await expect(removeHeartbeat(db, createWorkerId())).rejects.toMatchObject({
        code: 'HEARTBEAT_REMOVE_FAILED',
      });
      await expect(recordHeartbeat(db, '../bad')).rejects.toMatchObject({
        code: 'WORKER_ID_INVALID',
      });
      expect(await isWorkerHealthy(db, createWorkerId())).toBe(false);
      db.pool.emit('error', failure);
      expect(logs.join('')).not.toContain('canary');
      expect(logs.join('')).toContain('DB_CONNECTION_LOST');
    } finally {
      await db.close();
    }
  });
});
