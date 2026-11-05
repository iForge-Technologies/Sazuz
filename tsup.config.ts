import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'scripts/bootstrap.ts',
    'scripts/migrate.ts',
    'scripts/worker-healthcheck.ts',
    'scripts/cli.ts',
    'scripts/sandbox-proxy.ts',
    'scripts/web-live-gateway.ts',
    'scripts/sandbox-acceptance.ts',
    'scripts/voice-acceptance.ts',
  ],
  format: ['esm'],
  platform: 'node',
  target: 'node26',
  sourcemap: true,
  clean: true,
  noExternal: [/^@sazuz\//],
  skipNodeModulesBundle: true,
});
