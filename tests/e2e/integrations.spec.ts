import { expect, test, type Page } from '@playwright/test';
import { z } from 'zod';
import { s2aRecordSchema, s2aRunInputSchema, s2aUpdateSchema } from '@sazuz/core/s2a';
import { channelConnectionSchema, mcpConnectionSchema } from '@sazuz/config/integrations';
import {
  fixtureId,
  fixtureMission,
  mockDurableWorkspace,
  projectId,
  stamp,
} from './durable-fixture';

async function integrations(page: Page) {
  await mockDurableWorkspace(page);
  let workflow = s2aRecordSchema.parse({
    id: fixtureId('wf'),
    projectId,
    name: 'Weekly review',
    description: 'Review the weekly update',
    revision: 1,
    publishedRevision: 1,
    updatedAt: stamp,
    graph: {
      entry: 'start',
      nodes: [
        {
          id: 'start',
          kind: 'value',
          name: 'Prepare data',
          value: { message: 'Hello from S2A' },
          next: null,
          x: 70,
          y: 80,
        },
      ],
    },
  });
  const runs: z.infer<typeof s2aRunInputSchema>[] = [];
  const channels = {
    version: 1,
    connections: [
      channelConnectionSchema.parse({
        id: 'whatsapp_personal',
        name: 'Personal WhatsApp',
        kind: 'whatsapp-qr',
        projectId,
      }),
    ],
  };
  const mcp = {
    version: 1,
    connections: [
      mcpConnectionSchema.parse({
        id: 'research',
        name: 'Research tools',
        url: 'https://example.com/mcp',
      }),
    ],
  };
  let connected = false;
  let updates = 0;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/s2a') return route.fulfill({ json: [workflow] });
    if (path === '/api/s2a/tools')
      return route.fulfill({
        json: [
          {
            name: 'time.now',
            description: 'Current time',
            effect: 'read',
            inputSchema: { type: 'object' },
          },
        ],
      });
    if (path === `/api/s2a/${workflow.id}`) {
      const { expectedRevision, ...body } = s2aUpdateSchema.parse(request.postDataJSON());
      expect(expectedRevision).toBe(workflow.revision);
      workflow = { ...workflow, ...body, revision: workflow.revision + 1 };
      updates++;
      return route.fulfill({ json: workflow });
    }
    if (path === `/api/s2a/${workflow.id}/publish`) {
      workflow.publishedRevision = workflow.revision;
      return route.fulfill({ json: workflow });
    }
    if (path === `/api/s2a/${workflow.id}/runs`) return route.fulfill({ json: [] });
    if (path === `/api/s2a/${workflow.id}/schedule`) return route.fulfill({ json: null });
    if (path === `/api/s2a/${workflow.id}/run`) {
      runs.push(s2aRunInputSchema.parse(request.postDataJSON()));
      if (runs.length === 1) return route.abort('connectionfailed');
      return route.fulfill({ json: fixtureMission('queued') });
    }
    if (path === '/api/channels/connections') {
      if (request.method() === 'PUT') {
        const next = z
          .object({ connections: z.array(channelConnectionSchema) })
          .parse(request.postDataJSON());
        channels.connections = next.connections;
        channels.version++;
      }
      return route.fulfill({ json: channels });
    }
    if (path.endsWith('/whatsapp_personal/connect')) {
      connected = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith('/whatsapp_personal/disconnect')) {
      connected = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith('/whatsapp_personal/status'))
      return route.fulfill({
        json: {
          state: connected ? 'qr' : 'disconnected',
          qr: connected
            ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII='
            : null,
          expiresAt: connected ? '2030-01-01T00:00:00.000Z' : null,
        },
      });
    if (path === '/api/mcp/connections') {
      if (request.method() === 'PUT') {
        const next = z
          .object({ connections: z.array(mcpConnectionSchema) })
          .parse(request.postDataJSON());
        mcp.connections = next.connections;
        mcp.version++;
      }
      return route.fulfill({ json: mcp });
    }
    if (path === '/api/mcp/discover')
      return route.fulfill({
        json: {
          tools: [
            {
              name: 'search',
              description: 'Search records',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
              enabled: false,
              effect: 'unknown',
            },
          ],
        },
      });
    return route.fallback();
  });
  return { runs, channels, mcp, updates: () => updates };
}

test('S2A validates JSON, saves connected nodes and recovers an ambiguous run with the same request ID', async ({
  page,
}) => {
  const state = await integrations(page);
  await page.goto('/s2a');
  await page.getByRole('button', { name: /Weekly review/ }).click();
  await page.getByLabel('Value (JSON)', { exact: true }).fill('{broken');
  await page.getByRole('button', { name: 'Save revision' }).click();
  expect(state.updates()).toBe(0);
  await page.getByLabel('Value (JSON)', { exact: true }).fill('{"message":"Updated"}');
  await page.getByRole('button', { name: '+ Approval', exact: true }).click();
  await page.getByLabel('Selected node').selectOption({ label: 'Prepare data' });
  await page.getByLabel('Next node', { exact: true }).selectOption({ label: 'Review action' });
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect.poll(state.updates).toBe(1);
  await page.getByRole('button', { name: 'Publish revision' }).click();
  await expect(page.getByText('Published revision 2', { exact: false })).toBeVisible();
  await page.getByLabel('Run input (JSON object)').fill('{"week":42}');
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
  await expect(page.getByText(/The run request is unresolved/)).toBeVisible();
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
  await expect(page.getByRole('link', { name: /Open running mission/ })).toBeVisible();
  expect(state.runs).toHaveLength(2);
  expect(state.runs[0]).toEqual(state.runs[1]);
});

test('MCP discovery requires reviewed permissions and preserves vault references', async ({
  page,
}) => {
  const state = await integrations(page);
  await page.goto('/mcp-connections');
  await page.getByRole('button', { name: 'Discover tools' }).click();
  await expect(page.getByLabel('search', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Effect', { exact: true })).toHaveValue('unknown');
  await page.getByLabel('Effect', { exact: true }).selectOption('read');
  await page.getByLabel('search', { exact: true }).check();
  await page.getByLabel('Chief of Staff', { exact: true }).check();
  await page.getByLabel('Enable connection').check();
  await page.getByLabel('Bearer token').selectOption(`secret://${fixtureId('sec')}`);
  await page.getByRole('button', { name: 'Save connections' }).click();
  await expect.poll(() => state.mcp.version).toBe(2);
  expect(state.mcp.connections[0]).toMatchObject({
    enabled: true,
    agents: ['cos'],
    secretRef: `secret://${fixtureId('sec')}`,
    tools: [{ effect: 'read', enabled: true }],
  });
});

test('WhatsApp offers both modes and QR pairing requires saved, enabled settings', async ({
  page,
}) => {
  const state = await integrations(page);
  await page.goto('/channels');
  await expect(
    page.getByRole('button', { name: '+ WhatsApp Cloud API', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '+ WhatsApp QR session', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/unofficial linked-device client/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect / show QR' })).toBeDisabled();
  await page.getByLabel('Allowed sender IDs (one per line)').fill('15551234567@s.whatsapp.net');
  await page.getByLabel('Enable channel').check();
  await page.getByRole('button', { name: 'Save channels' }).click();
  await expect.poll(() => state.channels.version).toBe(2);
  await page.getByRole('button', { name: 'Connect / show QR' }).click();
  await expect(page.getByRole('img', { name: /Scan this temporary QR/ })).toBeVisible();
  await page.getByRole('button', { name: 'Unlink device' }).click();
  await expect(page.getByRole('img', { name: /Scan this temporary QR/ })).toHaveCount(0);
});

for (const path of ['s2a', 'channels', 'mcp'])
  for (const mode of ['desktop', 'mobile-dark'] as const) {
    test(`${path} fits ${mode} without browser errors`, async ({ page }, info) => {
      await integrations(page);
      if (mode === 'mobile-dark') {
        await page.setViewportSize({ width: 375, height: 900 });
        await page.emulateMedia({ colorScheme: 'dark' });
      }
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`/${path}`);
      if (path === 's2a') await page.getByRole('button', { name: /Weekly review/ }).click();
      await expect(
        page.getByRole('heading', {
          name: path === 's2a' ? 'S2A Studio' : path === 'mcp' ? 'MCP connections' : 'Channels',
          exact: true,
        }),
      ).toBeVisible();
      if (path === 'mcp') await page.getByRole('button', { name: 'Discover tools' }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        page.viewportSize()!.width,
      );
      expect(errors).toEqual([]);
      await page.screenshot({ path: info.outputPath(`${path}-${mode}.png`), fullPage: true });
    });
  }
