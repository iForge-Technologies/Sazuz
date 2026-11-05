import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node26',
  clean: true,
  sourcemap: true,
  noExternal: [/^@sazuz\//],
  skipNodeModulesBundle: true,
});
