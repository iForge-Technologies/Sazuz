import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test';
import { healthSchema, type Health } from '@sazuz/core/health';

declare global {
  interface Window {
    __sazuzCspViolations?: string[];
  }
}

const healthPath = '**/api/health';

function verifiedHealth(status: number, payload: unknown): Health {
  expect(status, 'The running stack must return healthy HTTP 200.').toBe(200);
  const health = healthSchema.safeParse(payload);
  if (!health.success) throw new Error('The running stack returned an invalid health response.');
  expect(health.data.status).toBe('ok');
  expect(health.data.services.database.status).toBe('ok');
  expect(health.data.services.worker.status).toBe('ok');
  expect(health.data.services.worker.activeCount).toBeGreaterThanOrEqual(1);
  return health.data;
}

async function readVerifiedResponse(response: Pick<Response, 'status' | 'json'>): Promise<Health> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('The running stack returned an unreadable health response.');
  }
  return verifiedHealth(response.status(), payload);
}

async function readLiveHealth(request: APIRequestContext): Promise<Health> {
  const response = await request.get('/api/health');
  expect(response.headers()['cache-control']).toContain('no-store');
  return readVerifiedResponse(response);
}

function isHealthResponse(response: Response): boolean {
  return (
    new URL(response.url()).pathname === '/api/health' && response.request().method() === 'GET'
  );
}

async function expectHealthyPage(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'System health', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Core services operational' })).toBeVisible();
  await expect(page.locator('[data-health-status="ok"]')).toBeVisible();
  const database = page.getByRole('article', { name: 'Database', exact: true });
  const worker = page.getByRole('article', { name: 'Worker', exact: true });
  await expect(database.getByText('Operational', { exact: true })).toBeVisible();
  await expect(worker.getByText('Operational', { exact: true })).toBeVisible();
  await expect(
    worker.getByText('Active workers', { exact: true }).locator('..').locator('dd'),
  ).toHaveText(/^[1-9]\d*$/);
}

test.describe('real running stack', () => {
  test('health API and both service cards report actual readiness', async ({ page, request }) => {
    const health = await readLiveHealth(request);
    expect(health.services.worker.lastSeenAt).not.toBeNull();
    await page.goto('/health');
    await expectHealthyPage(page);
    const database = page.getByRole('article', { name: 'Database', exact: true });
    await expect(database.locator('time')).toHaveAttribute('datetime', /T.*Z$/);
    await expect(database.getByText(/\d[\d,.]* ms$/)).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(2);
  });

  test('home navigation, skip link, and manual refresh work from the keyboard', async ({
    page,
  }) => {
    await page.goto('/');
    await expectHealthyPage(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();

    const healthLink = page.getByRole('navigation').getByRole('link', { name: 'System health' });
    await healthLink.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/health$/);
    await expectHealthyPage(page);

    const automaticRefresh = page.getByRole('button', { name: 'Automatic refresh', exact: true });
    await automaticRefresh.focus();
    await page.keyboard.press('Space');
    await expect(automaticRefresh).toHaveAttribute('aria-pressed', 'false');

    const refresh = page.getByRole('button', { name: 'Refresh health', exact: true });
    await expect(refresh).toBeEnabled();
    await refresh.focus();
    const responsePromise = page.waitForResponse(isHealthResponse);
    await page.keyboard.press('Enter');
    const response = await responsePromise;
    await readVerifiedResponse(response);
    await expect(refresh).toBeEnabled();
    await expectHealthyPage(page);
  });

  test('automatic polling pauses and resumes on the ten-second interval', async ({ page }) => {
    await page.goto('/health');
    await expectHealthyPage(page);
    const automaticRefresh = page.getByRole('button', { name: 'Automatic refresh', exact: true });
    await expect(automaticRefresh).toHaveAttribute('aria-pressed', 'true');
    await automaticRefresh.click();
    await expect(automaticRefresh).toHaveAttribute('aria-pressed', 'false');

    // Observe a full interval: a pressed-state assertion alone cannot prove polling stopped.
    await expect(page.waitForResponse(isHealthResponse, { timeout: 11_000 })).rejects.toThrow(
      /Timeout 11000ms exceeded/,
    );
    const responsePromise = page.waitForResponse(isHealthResponse, { timeout: 13_000 });
    await automaticRefresh.click();
    await expect(automaticRefresh).toHaveAttribute('aria-pressed', 'true');
    const response = await responsePromise;
    await readVerifiedResponse(response);
    await expectHealthyPage(page);
  });

  for (const width of [320, 375]) {
    test(`service cards and controls fit a ${width}px screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      await page.goto('/health');
      await expectHealthyPage(page);
      await expect(
        page.getByRole('button', { name: 'Refresh health', exact: true }),
      ).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      for (const service of ['Database', 'Worker']) {
        const card = page.getByRole('article', { name: service, exact: true });
        await card.scrollIntoViewIfNeeded();
        await expect(card).toBeInViewport();
        const bounds = await card.boundingBox();
        expect(bounds).not.toBeNull();
        if (!bounds) throw new Error('A service card has no visible bounds.');
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      }
    });
  }

  test('nonce CSP permits the app without browser errors or policy violations', async ({
    page,
  }, testInfo) => {
    const browserErrors: string[] = [];
    page.on('pageerror', () => browserErrors.push('Browser runtime error'));
    await page.addInitScript(() => {
      const violations: string[] = [];
      window.__sazuzCspViolations = violations;
      document.addEventListener('securitypolicyviolation', (event) => {
        violations.push(event.violatedDirective);
      });
    });

    const response = await page.goto('/health');
    await expectHealthyPage(page);
    if (!response) throw new Error('The health page did not return a navigation response.');
    const headers = response.headers();
    const policy = headers['content-security-policy'] ?? '';
    const scriptPolicy =
      policy.split(';').find((directive) => directive.trim().startsWith('script-src ')) ?? '';
    expect(scriptPolicy).toContain("'strict-dynamic'");
    expect(scriptPolicy).toMatch(/'nonce-[a-zA-Z0-9_-]+'/);
    expect(scriptPolicy).not.toContain("'unsafe-inline'");
    if (testInfo.config.metadata['runtimeMode'] === 'development') {
      expect(scriptPolicy).toContain("'unsafe-eval'");
    } else {
      expect(scriptPolicy).not.toContain("'unsafe-eval'");
    }
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');

    const inlineNonces = await page.locator('script:not([src])').evaluateAll(
      (scripts, development) =>
        scripts
          // Next's development overlay uses an empty script as its portal container.
          // Any inline content makes it executable and must still require a nonce.
          .filter(
            (script) =>
              !(
                development &&
                script.getAttribute('data-nextjs-dev-overlay') === 'true' &&
                script.textContent === ''
              ),
          )
          .map((script) => (script as HTMLScriptElement).nonce ?? ''),
      testInfo.config.metadata['runtimeMode'] === 'development',
    );
    expect(inlineNonces.length).toBeGreaterThan(0);
    for (const nonce of inlineNonces) {
      expect(nonce.length).toBeGreaterThan(0);
      expect(scriptPolicy).toContain(`'nonce-${nonce}'`);
    }
    await page.getByRole('button', { name: 'Refresh health', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Refresh health', exact: true })).toBeEnabled();
    await expectHealthyPage(page);
    const violations = await page.evaluate(() => {
      return window.__sazuzCspViolations;
    });
    expect(browserErrors).toEqual([]);
    expect(violations).toEqual([]);
  });
});

test.describe('mocked browser failure regressions — not service acceptance', () => {
  test('a valid HTTP 503 preserves degraded service details', async ({ page }) => {
    const degraded = healthSchema.parse({
      status: 'degraded',
      checkedAt: '2026-11-03T12:00:00.000Z',
      services: {
        database: { status: 'ok', latencyMs: 3 },
        worker: { status: 'missing', activeCount: 0, lastSeenAt: null },
      },
    });
    await page.route(healthPath, (route) => route.fulfill({ status: 503, json: degraded }));
    await page.goto('/health');
    await expect(page.getByRole('heading', { name: 'Services need attention' })).toBeVisible();
    await expect(page.locator('[data-health-status="degraded"]')).toBeVisible();
    await expect(
      page
        .getByRole('article', { name: 'Database', exact: true })
        .getByText('Operational', { exact: true }),
    ).toBeVisible();
    const worker = page.getByRole('article', { name: 'Worker', exact: true });
    await expect(worker.getByText('No heartbeat', { exact: true })).toBeVisible();
    await expect(
      worker.getByText('Active workers', { exact: true }).locator('..').locator('dd'),
    ).toHaveText('0');
  });

  test('a failed refresh does not leave a stale healthy result on screen', async ({ page }) => {
    await page.goto('/health');
    await expectHealthyPage(page);
    await page.getByRole('button', { name: 'Automatic refresh', exact: true }).click();
    await page.route(healthPath, (route) => route.abort('connectionfailed'));
    await page.getByRole('button', { name: 'Refresh health', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Health check unavailable' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Core services operational' })).toHaveCount(0);
    await expect(
      page
        .getByRole('article', { name: 'Database', exact: true })
        .getByText('Unknown', { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('article', { name: 'Worker', exact: true })
        .getByText('Unknown', { exact: true }),
    ).toBeVisible();
  });

  test('malformed JSON is reported without displaying its contents', async ({ page }) => {
    await page.route(healthPath, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{secret-canary-not-for-display',
      }),
    );
    await page.goto('/health');
    await expect(page.getByRole('heading', { name: 'Health check unavailable' })).toBeVisible();
    await expect(
      page.getByText('The latest response could not be verified. Refresh to try again.'),
    ).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('secret-canary-not-for-display');
  });

  test('the proxy unavailable response reports unknown service status', async ({ page }) => {
    await page.route(healthPath, (route) =>
      route.fulfill({ status: 503, json: { error: { code: 'HEALTH_UNAVAILABLE' } } }),
    );
    await page.goto('/health');
    await expect(page.getByRole('heading', { name: 'Health check unavailable' })).toBeVisible();
    await expect(page.locator('[data-health-status="unavailable"]')).toBeVisible();
    await expect(
      page
        .getByRole('article', { name: 'Database', exact: true })
        .getByText('Unknown', { exact: true }),
    ).toBeVisible();
    const worker = page.getByRole('article', { name: 'Worker', exact: true });
    await expect(worker.getByText('Unknown', { exact: true })).toBeVisible();
    await expect(
      worker.getByText('Active workers', { exact: true }).locator('..').locator('dd'),
    ).toHaveText('Not available');
  });
});
