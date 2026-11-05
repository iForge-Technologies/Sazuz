import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import base from '../../playwright.config';

/** Run after the existing e2e suite on its same disposable production instance. */
export default defineConfig({
  ...base,
  testDir: '.',
  outputDir: '../../test-results/frontend',
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: resolve(import.meta.dirname, '../../playwright-report/frontend'),
        open: 'never',
      },
    ],
  ],
  timeout: 180_000,
});
