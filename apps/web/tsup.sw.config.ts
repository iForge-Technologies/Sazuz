import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/service-worker.ts'],
  outDir: 'public',
  format: ['iife'],
  platform: 'browser',
  target: 'es2023',
  minify: true,
  splitting: false,
  clean: false,
  noExternal: ['zod'],
});
