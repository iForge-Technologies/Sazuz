import { defineConfig } from '@playwright/test';
import { z } from 'zod';

const baseUrlSchema = z
  .string()
  .url()
  .transform((value) => new URL(value))
  .refine(
    (url) =>
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '',
  )
  .transform((url) => url.origin);

const settings = z
  .strictObject({
    baseURL: baseUrlSchema.default('http://127.0.0.1:7777'),
    channel: z.enum(['chromium', 'chrome', 'msedge']).default('chromium'),
    mode: z.enum(['production', 'development']).default('production'),
  })
  .safeParse({
    baseURL: process.env.PLAYWRIGHT_BASE_URL,
    channel: process.env.PLAYWRIGHT_CHANNEL,
    mode: process.env.PLAYWRIGHT_MODE,
  });

if (!settings.success) {
  throw new Error(
    'Invalid browser test configuration. PLAYWRIGHT_BASE_URL must be an HTTP(S) origin without credentials, paths, or query parameters; PLAYWRIGHT_CHANNEL must be chromium, chrome, or msedge; PLAYWRIGHT_MODE must be production or development.',
  );
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  metadata: { runtimeMode: settings.data.mode },
  outputDir: './test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  // Start the real stack before running these checks; missing dependencies must fail visibly.
  use: {
    baseURL: settings.data.baseURL,
    browserName: 'chromium',
    // Full Chromium supports microphone capture; its separate headless shell may not.
    channel: settings.data.channel,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'en-US',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    serviceWorkers: 'block',
  },
});
