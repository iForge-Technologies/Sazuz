import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node26',
  sourcemap: true,
  clean: true,
  noExternal: [/^@sazuz\//],
  skipNodeModulesBundle: true,
});
