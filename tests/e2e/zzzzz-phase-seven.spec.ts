import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { settingsDocumentSchema } from '@sazuz/config/settings';
import { agentRevisionSchema } from '@sazuz/core/agents';
import { bridgeDeviceSchema } from '@sazuz/core/bridge';
import { mcpClientSchema } from '@sazuz/core/mcp';
import { missionDetailSchema } from '@sazuz/core/missions';
import { projectSchema } from '@sazuz/core/work';
import { BridgeState } from '../../packages/bridge/src/state';
import { phaseSevenModelKey, startPhaseSevenModel } from './phase-seven-model';
import { waitForProductionExtractions } from './production-jobs';

test('Phase 7 production: independent MCP client delegates to the compiled Bridge through the web gateway and worker', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(180000);
  test.skip(
    !process.env.PLAYWRIGHT_SETUP_DATA_DIR,
    'Requires the fresh production stack used by the setup suite.',
  );
  const origin = z.string().parse(testInfo.project.use.baseURL),
    model = await startPhaseSevenModel(),
    directory = await mkdtemp(join(tmpdir(), 'sazuz-phase7-production-')),
    root = join(directory, 'scope'),
    deviceToken = `phase7-production-bridge-canary-${randomUUID()}`,
    clientToken = `phase7-production-client-canary-${randomUUID()}`,
    client = new Client(
      { name: 'independent-production-client', version: '1' },
      { capabilities: {} },
    );
  let state: BridgeState | undefined, child: ChildProcess | undefined;
  const logs: string[] = [],
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const canaries = [phaseSevenModelKey, deviceToken, clientToken];
  const api = async <T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown) => {
    const response = await context.request.fetch(`/api/${path}`, {
      method,
      headers: { origin },
      ...(body === undefined ? {} : { data: body }),
    });
    expect(response.status(), `${method} ${path}`).toBe(200);
    const text = await response.text();
    for (const canary of canaries) expect(text).not.toContain(canary);
    return schema.parse(JSON.parse(text));
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = z
      .object({
        isError: z.boolean().optional(),
        content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
      })
      .parse(await client.callTool({ name, arguments: args }));
    expect(result.isError).not.toBe(true);
    for (const canary of canaries) expect(JSON.stringify(result)).not.toContain(canary);
    return z.record(z.string(), z.json()).parse(JSON.parse(result.content[0]!.text));
  };
  try {
    await api('POST', 'auth/sign-in/email', z.unknown(), {
      email: 'browser-owner@example.test',
      password: 'Browser-admin-password-7814',
    });
    const secret = async (name: string, value: string) =>
      api('POST', 'vault/secrets', z.object({ reference: z.string() }), { name, value });
    const modelSecret = await secret('Phase 7 model fixture', phaseSevenModelKey);
    let settings = await api('GET', 'settings', settingsDocumentSchema);
    await api('PUT', 'settings/providers', z.unknown(), {
      expectedVersion: settings.providers.version,
      value: {
        items: [
          {
            id: 'phase7-fixture',
            name: 'Phase 7 local model',
            kind: 'openai-compatible',
            baseUrl: model.baseUrl,
            secretRef: modelSecret.reference,
            locality: 'local',
            enabled: true,
          },
        ],
      },
    });
    await api('POST', 'providers/phase7-fixture/discover', z.unknown(), {});
    settings = await api('GET', 'settings', settingsDocumentSchema);
    const assignment = { providerId: 'phase7-fixture', modelId: 'gpt-4o' };
    await api('PUT', 'settings/models', z.unknown(), {
      expectedVersion: settings.models.version,
      value: {
        ...settings.models.value,
        roles: {
          planner: assignment,
          executor: assignment,
          fast: assignment,
          vision: assignment,
          embedding: null,
        },
        modelLimits: [{ ...assignment, contextWindow: 131072, maxOutput: 4096 }],
        providerRateLimits: [{ providerId: 'phase7-fixture', requestsPerMinute: 600, burst: 50 }],
      },
    });
    const project = await api('POST', 'projects', projectSchema, {
      name: 'Phase 7 scoped laptop',
      privacy: 'private',
      budgetUsd: 10,
    });
    const operator = await api('GET', 'agents/operator', agentRevisionSchema);
    await api('PUT', 'agents/operator', agentRevisionSchema, {
      expectedVersion: operator.version,
      definition: {
        ...operator.definition,
        tools: [...new Set([...operator.definition.tools, 'local.*'])],
      },
    });
    const deviceSecret = await secret('Phase 7 laptop credential', deviceToken);
    let device = await api('POST', 'bridge/devices', bridgeDeviceSchema, {
      name: 'Production laptop fixture',
      projectId: project.id,
      secretRef: deviceSecret.reference,
    });
    expect(device.grant).toBeNull();
    await mkdir(root);
    await writeFile(join(root, 'marker.txt'), 'phase7-production-scoped-marker');
    await writeFile(join(directory, 'outside.txt'), 'phase7-production-outside-must-remain-hidden');
    state = await BridgeState.create(
      join(directory, 'state'),
      'Phase7-companion-passphrase-90214',
      {
        endpoint: origin.replace(/^http/, 'ws') + '/bridge',
        deviceId: device.id,
        projectId: project.id,
        token: deviceToken,
      },
      { folders: [{ alias: 'notes', root, mode: 'write' }], commands: [] },
    );
    const companionEntry = z
      .string()
      .refine(isAbsolute)
      .parse(process.env.PLAYWRIGHT_BRIDGE_ENTRY ?? resolve('apps/bridge/dist/main.js'));
    child = spawn(process.execPath, [companionEntry, 'run', '--state', state.directory], {
      cwd: dirname(companionEntry),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (value: Buffer) => {
        if (logs.length < 200) logs.push(value.toString('utf8'));
      });
    await expect
      .poll(
        async () => {
          device = await api('GET', `bridge/devices/${device.id}`, bridgeDeviceSchema);
          return device.online && !!device.offeredPin;
        },
        { timeout: 15000, intervals: [250, 500] },
      )
      .toBe(true);
    device = await api('PUT', `bridge/devices/${device.id}`, bridgeDeviceSchema, {
      expectedVersion: device.version,
      grant: {
        ...device.offered,
        pin: device.offeredPin,
        agents: ['operator'],
        tools: ['local.fs.read', 'local.fs.write'],
      },
    });
    await expect
      .poll(() => logs.join('\n').split('BRIDGE_CONNECTED').length - 1, { timeout: 15000 })
      .toBeGreaterThanOrEqual(2);
    model.useDevice(device.id);
    const delegated = await secret('Phase 7 independent client', clientToken);
    const grant = await api('POST', 'mcp/clients', mcpClientSchema, {
      name: 'Independent production client',
      projectId: project.id,
      secretRef: delegated.reference,
      tools: ['create_mission', 'get_mission_status'],
      allowPrivate: true,
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        requestInit: { headers: { authorization: `Bearer ${clientToken}` } },
      }),
    );
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'create_mission',
      'get_mission_status',
    ]);
    const create = async (goal: string) => {
      const input = { requestId: randomUUID(), goal, agent: 'operator' };
      const created = await call('create_mission', input);
      expect((await call('create_mission', input)).missionId).toBe(created.missionId);
      return z.string().parse(created.missionId);
    };
    const wait = async (id: string, status: string) => {
      let detail: z.infer<typeof missionDetailSchema> | undefined;
      await expect
        .poll(
          async () => {
            detail = await api('GET', `missions/${id}`, missionDetailSchema);
            return detail.mission.run.status;
          },
          { timeout: 45000, intervals: [500, 1000] },
        )
        .toBe(status);
      return detail!;
    };
    const readId = await create('Phase7 read the authorized marker.');
    const read = await wait(readId, 'completed');
    expect(read.mission.run.tainted).toBe(true);
    expect(JSON.stringify(read)).toContain('phase7-production-scoped-marker');
    expect(JSON.stringify(read)).toContain('<untrusted>');
    expect((await call('get_mission_status', { missionId: readId })).status).toBe('completed');
    const outsideId = await create('Phase7 attempt an outside path.');
    const outside = await wait(outsideId, 'completed');
    expect(JSON.stringify(outside)).not.toContain('phase7-production-outside-must-remain-hidden');
    expect(JSON.stringify(outside)).toContain('../outside.txt');
    expect(JSON.stringify(outside)).toContain(
      'Invalid tool or arguments. Use the supplied schema.',
    );
    const writeId = await create('Phase7 perform the approved write.');
    const waiting = await wait(writeId, 'waiting_approval');
    await expect(readFile(join(root, 'approved.txt'))).rejects.toThrow();
    const approval = waiting.approvals.find((item) => item.status === 'pending')!;
    await api('POST', `approvals/${approval.id}/decision`, z.unknown(), {
      version: approval.version,
      action: 'approve',
    });
    const written = await wait(writeId, 'completed');
    expect(await readFile(join(root, 'approved.txt'), 'utf8')).toBe('phase7-approved-local-write');
    expect(written.approvals).toEqual([
      expect.objectContaining({ id: approval.id, status: 'resolved', toolName: 'local.fs.write' }),
    ]);
    await waitForProductionExtractions(context.request, [
      read.mission.run.id,
      outside.mission.run.id,
      written.mission.run.id,
    ]);
    await page.goto('/connectors');
    const card = page.getByRole('region', { name: 'Local Bridge', exact: true });
    await expect(
      card
        .getByRole('article')
        .filter({ hasText: device.id })
        .getByRole('heading', { name: 'Production laptop fixture', exact: true }),
    ).toBeVisible();
    expect(await card.innerText()).not.toContain(root);
    await page.goto(`/missions/${readId}`);
    await expect(page.getByRole('main')).toContainText('phase7-production-scoped-marker');
    await api('POST', `mcp/clients/${grant.id}/control`, mcpClientSchema, {
      expectedVersion: grant.version,
      enabled: false,
    });
    await expect(client.listTools()).rejects.toThrow();
    await api('POST', `bridge/devices/${device.id}/control`, bridgeDeviceSchema, {
      expectedVersion: device.version,
      enabled: false,
    });
    for (const canary of canaries)
      expect(
        JSON.stringify({ logs, requests: model.requests, read, outside, written }),
      ).not.toContain(canary);
    expect(model.failures).toEqual([]);
    expect(errors).toEqual([]);
    await testInfo.attach('phase7-production-evidence', {
      body: JSON.stringify({
        readMissionId: readId,
        outsideMissionId: outsideId,
        writeMissionId: writeId,
        compiledCompanion: true,
        webGateway: true,
        scopedRead: true,
        outsideRefused: true,
        approvedWrites: 1,
        mcpReplay: true,
        revoked: true,
        credentialsAbsent: true,
        modelRequests: model.requests.length,
      }),
      contentType: 'application/json',
    });
  } finally {
    await client.close();
    if (child && child.exitCode === null)
      await new Promise<void>((resolve) => {
        child!.once('close', () => resolve());
        child!.kill();
      });
    state?.close();
    await model.close();
    await testInfo.attach('phase7-protocol-diagnostics', {
      body: JSON.stringify({
        companion: logs,
        modelRequests: model.requests.length,
        failures: model.failures,
      }),
      contentType: 'application/json',
    });
    if (
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
      directory.includes('sazuz-phase7-production-')
    )
      await rm(directory, { recursive: true, force: true });
  }
});
