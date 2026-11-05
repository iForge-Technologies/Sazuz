import { expect, test } from '@playwright/test';
import type { z } from 'zod';
import {
  mcpSaveSchema,
  mcpServerSchema,
  mcpClientInputSchema,
  mcpClientSchema,
} from '@sazuz/core/mcp';
import { fixtureId, mockDurableWorkspace, projectId, stamp } from './durable-fixture';

test('reviews MCP effects and scoped clients with keyboard and mobile controls', async ({
  page,
}) => {
  await mockDurableWorkspace(page);
  const catalogue = {
    serverName: 'Vendor fixture',
    serverVersion: '1',
    sha256: 'a'.repeat(64),
    tools: [
      {
        name: 'lookup',
        description: 'Untrusted vendor hint',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      },
    ],
  };
  const servers: z.infer<typeof mcpServerSchema>[] = [],
    clients: z.infer<typeof mcpClientSchema>[] = [];
  await page.route('**/api/mcp/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/mcp/inspect') return route.fulfill({ json: catalogue });
    if (path === '/api/mcp/servers') {
      if (route.request().method() === 'POST') {
        const input = mcpSaveSchema.parse(route.request().postDataJSON());
        const saved = mcpServerSchema.parse({
          id: fixtureId('mcp'),
          projectId,
          version: 1,
          configuration: {
            name: input.name,
            transport: input.transport,
            catalogue,
            permissions: input.permissions,
            enabled: true,
          },
          warning: null,
          updatedAt: stamp,
        });
        servers.push(saved);
        return route.fulfill({ json: saved });
      }
      return route.fulfill({ json: servers });
    }
    if (path === '/api/mcp/clients') {
      if (route.request().method() === 'POST') {
        const input = mcpClientInputSchema.parse(route.request().postDataJSON());
        const saved = mcpClientSchema.parse({
          ...input,
          id: fixtureId('mct'),
          enabled: true,
          version: 1,
        });
        clients.push(saved);
        return route.fulfill({ json: saved });
      }
      return route.fulfill({ json: clients });
    }
    if (path.endsWith('/control')) {
      const client = clients[0]!;
      client.enabled = false;
      client.version++;
      return route.fulfill({ json: client });
    }
    return route.fulfill({ json: servers });
  });
  await page.goto('/connectors');
  const panel = page.getByRole('region', { name: 'MCP integrations' });
  await panel.getByLabel('MCP name', { exact: true }).fill('Reviewed MCP');
  await panel.getByRole('combobox', { name: 'MCP project', exact: true }).selectOption(projectId);
  await panel.getByLabel('HTTPS MCP endpoint', { exact: true }).fill('https://mcp.example.com/mcp');
  await panel.getByRole('button', { name: 'Inspect tools', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: 'Effect for lookup', exact: true })).toHaveValue(
    '',
  );
  await panel
    .getByRole('combobox', { name: 'Effect for lookup', exact: true })
    .selectOption('read');
  await panel.getByLabel('operator', { exact: true }).check();
  await panel.getByRole('button', { name: 'Save reviewed MCP installation', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Reviewed MCP', exact: true })).toBeVisible();
  expect(servers[0]!.configuration.permissions[0]).toMatchObject({
    effect: 'read',
    agents: ['operator'],
  });
  const addClient = panel.getByText('Add scoped MCP client', { exact: true });
  await addClient.focus();
  await page.keyboard.press('Enter');
  await panel.getByLabel('Client name', { exact: true }).fill('Desktop');
  await panel
    .getByRole('combobox', { name: 'Client project', exact: true })
    .selectOption(projectId);
  await panel
    .getByRole('combobox', { name: 'Client vault credential', exact: true })
    .selectOption(`secret://${fixtureId('sec')}`);
  await panel.getByLabel('create_mission', { exact: true }).check();
  await panel.getByRole('button', { name: 'Save MCP client', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Desktop', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Revoke client', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Enable client', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(await page.locator('body').innerText()).not.toContain('secret://');
});
