import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Windows credential tests exercise real PowerShell DACL inspection processes.
    testTimeout: process.platform === 'win32' ? 20_000 : 5_000,
    // Keep real Windows ACL subprocess checks from competing with other test workers.
    maxWorkers: process.platform === 'win32' ? 1 : 4,
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'scripts/**/*.test.ts',
      'tests/deployment/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: [
        'packages/core/src/**/*.ts',
        'packages/config/src/**/*.ts',
        'packages/vault/src/**/*.ts',
        'packages/policy/src/**/*.ts',
        'packages/runtime/src/**/*.ts',
        'packages/workflows/src/**/*.ts',
        'packages/evals/src/**/*.ts',
        'packages/ops/src/**/*.ts',
        'packages/orchestrator/src/**/*.ts',
        'packages/memory/src/**/*.ts',
        'packages/skills/src/**/*.ts',
        'packages/sandbox/src/**/*.ts',
        'packages/browser/src/**/*.ts',
        'packages/db/src/**/*.ts',
        'apps/browser/src/**/*.ts',
        'apps/server/src/app.ts',
        'apps/server/src/request-activity.ts',
        'apps/worker/src/heartbeat.ts',
      ],
      exclude: ['**/*.test.ts', '**/index.ts', '**/schema.ts', '**/migrate.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 75,
        'packages/policy/src/**': { lines: 80 },
        'packages/runtime/src/**': { lines: 80 },
        'packages/orchestrator/src/**': { lines: 80 },
        'packages/vault/src/**': { lines: 80 },
      },
    },
    restoreMocks: true,
    clearMocks: true,
  },
});
