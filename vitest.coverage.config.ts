import { defineConfig, mergeConfig } from 'vitest/config';
import unit from './vitest.config.js';

// Repository and HTTP coverage requires the real PostgreSQL suite as well as unit tests.
// Use Testcontainers, or the same dedicated *_test database as test:integration.
export default mergeConfig(
  unit,
  defineConfig({
    test: {
      include: [...unit.test!.include!, 'tests/integration/**/*.test.ts'],
      fileParallelism: false,
      maxWorkers: 1,
      hookTimeout: 120_000,
      testTimeout: 30_000,
    },
  }),
);
