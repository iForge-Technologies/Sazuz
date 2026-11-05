import { describe, expect, it } from 'vitest';
import { createLogger, healthSchema, type Health } from '@sazuz/core';
import { SecretRedactor } from '@sazuz/vault';
import { createApp } from './app.js';

const healthy: Health = {
  status: 'ok',
  checkedAt: '2026-11-03T00:00:00.000Z',
  services: {
    database: { status: 'ok', latencyMs: 1 },
    worker: { status: 'ok', activeCount: 1, lastSeenAt: '2026-11-03T00:00:00.000Z' },
  },
};

describe('health API', () => {
  it('serves validated health and generated OpenAPI with security headers', async () => {
    const app = await createApp({
      health: () => Promise.resolve(healthy),
      logger: createLogger('test', new SecretRedactor(), { write: () => undefined }),
    });
    try {
      const response = await app.inject('/api/health');
      expect(response.statusCode).toBe(200);
      expect(healthSchema.parse(response.json())).toEqual(healthy);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      const schema = await app.inject('/api/openapi.json');
      expect(schema.statusCode).toBe(200);
      expect(schema.body).toContain('/api/health');
      expect(schema.body).toContain('503');
      expect((await app.inject('/api/health?unknown=value')).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/health' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns 503 when the worker is missing', async () => {
    const degraded: Health = {
      ...healthy,
      status: 'degraded',
      services: {
        ...healthy.services,
        worker: { status: 'missing', activeCount: 0, lastSeenAt: null },
      },
    };
    const app = await createApp({
      health: () => Promise.resolve(degraded),
      logger: createLogger('test', new SecretRedactor(), { write: () => undefined }),
    });
    try {
      const response = await app.inject('/api/health');
      expect(response.statusCode).toBe(503);
      expect(healthSchema.parse(response.json())).toEqual(degraded);
    } finally {
      await app.close();
    }
  });

  it('never exposes failed dependency errors or request secrets', async () => {
    const canary = 'unregistered-dependency-password';
    const logs: string[] = [];
    const app = await createApp({
      health: () => Promise.reject(new Error(canary)),
      logger: createLogger('test', new SecretRedactor(), {
        write: (line) => {
          logs.push(line);
        },
      }),
    });
    try {
      const response = await app.inject({ url: '/api/health', headers: { authorization: canary } });
      expect(response.statusCode).toBe(500);
      expect(response.body).toContain('INTERNAL_ERROR');
      expect(response.body).not.toContain(canary);
      expect(logs.join('')).not.toContain(canary);
    } finally {
      await app.close();
    }
  });

  it('keeps unknown routes and invalid queries free of reflected request data', async () => {
    const canary = 'unregistered-request-canary';
    const logs: string[] = [];
    const app = await createApp({
      health: () => Promise.resolve(healthy),
      logger: createLogger('test', new SecretRedactor(), {
        write: (line) => {
          logs.push(line);
        },
      }),
    });
    try {
      const missing = await app.inject(`/${canary}?credential=${canary}`);
      expect(missing.statusCode).toBe(404);
      expect(missing.body).toContain('NOT_FOUND');
      expect(missing.body).not.toContain(canary);
      expect(missing.headers['cache-control']).toBe('no-store');

      const invalid = await app.inject(`/api/health?unknown=${canary}`);
      expect(invalid.statusCode).toBe(400);
      expect(invalid.body).not.toContain(canary);
      expect(invalid.headers['cache-control']).toBe('no-store');
      expect(logs.join('')).not.toContain(canary);
    } finally {
      await app.close();
    }
  });
});
