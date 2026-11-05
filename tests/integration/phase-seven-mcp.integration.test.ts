import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mcpCatalogueSchema, mcpSaveSchema, mcpServerSchema } from '@sazuz/core/mcp';
import {
  createMission,
  getMission,
  readSettings,
  saveSetting,
  settingsHistory,
  runs,
  mcpCalls,
  mcpServers,
  mcpServerVersions,
  jsonValue,
  valueHash,
  toolCalls,
  workerHeartbeats,
  workKey,
} from '@sazuz/db';
import { ToolRegistry } from '../../packages/tools/src/index.js';
import {
  mcpTools,
  selectedMcp,
  mcpToolName,
  workerExternalDispatch,
} from '../../packages/mcp/src/index.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { ensureAgents, getAgent, saveAgent } from '../../packages/orchestrator/src/index.js';
import { registerPhaseSeven } from '../../apps/server/src/phase-seven.js';
import { phaseFourFixture } from './phase-four-fixture.js';
import { createFixtureRouter } from './phase-three-runtime-worker.js';
import { mcpProtocolFixture } from './phase-seven-mcp-fixture.js';

describe('Phase 7 arbitrary MCP installation and durable policy gateway', () => {
  let fixture: Awaited<ReturnType<typeof phaseFourFixture>>,
    remote: Awaited<ReturnType<typeof mcpProtocolFixture>>;
  let installation: ReturnType<typeof mcpServerSchema.parse>;
  const token = 'phase7-mcp-transport-canary-2398127466';
  const workerId = workKey('wrk');
  let address: string, secretRef: string;
  beforeAll(async () => {
    remote = await mcpProtocolFixture(token);
    fixture = await phaseFourFixture((app, runtime) => {
      registerPhaseSeven(app, runtime, {
        transport: () =>
          Promise.resolve(
            new StreamableHTTPClientTransport(new URL(remote.url), {
              requestInit: { headers: { authorization: `Bearer ${token}` } },
              reconnectionOptions: {
                maxRetries: 0,
                initialReconnectionDelay: 100,
                maxReconnectionDelay: 100,
                reconnectionDelayGrowFactor: 1,
              },
            }),
          ),
      });
    });
    secretRef = (
      await fixture.runtime.vault.create({
        name: 'MCP transport',
        value: token,
        createdBy: fixture.userId,
      })
    ).reference;
    await ensureAgents(fixture.db, fixture.userId);
    const agent = await getAgent(fixture.db, fixture.userId, 'operator');
    await saveAgent(
      fixture.db,
      fixture.userId,
      'operator',
      {
        expectedVersion: agent.version,
        definition: { ...agent.definition, tools: [...agent.definition.tools, 'mcp.*'] },
      },
      [],
    );
    const settings = await readSettings(fixture.db);
    await saveSetting(fixture.db, {
      namespace: 'security',
      actorId: fixture.userId,
      expectedVersion: settings.security.version,
      value: { ...settings.security.value, preset: 'autonomous' },
    });
    await vi.waitFor(() =>
      expect(fixture.runtime.settings.security.value.preset).toBe('autonomous'),
    );
    address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    await fixture.db.orm.insert(workerHeartbeats).values({ id: workerId });
  });
  afterAll(async () => {
    await fixture?.close();
    await remote?.close();
  });
  function transport() {
    return { kind: 'http' as const, url: 'https://arbitrary.example.com/mcp', secretRef };
  }
  async function install(id?: string) {
    const inspected = await fixture.request('POST', '/api/mcp/inspect', {
      projectId: fixture.projectId,
      transport: transport(),
    });
    expect(inspected.statusCode, inspected.body).toBe(200);
    const catalogue = mcpCatalogueSchema.parse(inspected.json());
    const body = mcpSaveSchema.parse({
      projectId: fixture.projectId,
      name: 'Arbitrary vendor',
      transport: transport(),
      expectedPin: catalogue.sha256,
      expectedVersion: id ? installation.version : 0,
      permissions: [
        { tool: 'read_marker', effect: 'read', agents: ['operator'] },
        { tool: 'vendor_effect', agents: ['operator'] },
      ],
    });
    const response = await fixture.request(
      id ? 'PUT' : 'POST',
      id ? `/api/mcp/servers/${id}` : '/api/mcp/servers',
      body,
    );
    expect(response.statusCode, response.body).toBe(200);
    installation = mcpServerSchema.parse(response.json());
    return { catalogue, body };
  }
  async function mission(tool = 'vendor_effect') {
    await fixture.db.orm
      .update(workerHeartbeats)
      .set({ lastSeenAt: new Date() })
      .where(eq(workerHeartbeats.id, workerId));
    const created = await createMission(
      fixture.db,
      fixture.userId,
      {
        projectId: fixture.projectId,
        goal: 'Use the reviewed MCP tool on a fixture marker.',
        agent: 'operator',
        requestId: randomUUID(),
      },
      { maxSteps: 12, maxCostUsd: 1, maxWallTimeSeconds: 180 },
    );
    const dispatch = workerExternalDispatch({
      config: { serverUrl: address },
      workerId,
      key: () => Promise.resolve(fixture.runtime.plumbing.operatorKey),
    });
    const executor = createDurableExecutor({
      database: fixture.db,
      workerId,
      dataDir: fixture.directory,
      getSettings: () => fixture.runtime.settings,
      tools: new ToolRegistry(),
      dynamicTools: async (runId, agentId) => {
        const tools = mcpTools(await selectedMcp(fixture.db, runId, true), agentId, dispatch);
        return { tools, tainted: tools.length > 0 };
      },
      router: () =>
        createFixtureRouter({
          toolName: mcpToolName(installation.id, tool),
          args: { marker: 'allowed marker' },
        }),
    });
    await executor.execute(created.run.id);
    return { created, executor, detail: () => getMission(fixture.db, fixture.userId, created.id) };
  }
  async function approve(run: Awaited<ReturnType<typeof mission>>) {
    const approval = (await run.detail())!.approvals.find((item) => item.kind === 'policy')!;
    const response = await fixture.request('POST', `/api/approvals/${approval.id}/decision`, {
      version: approval.version,
      action: 'approve',
    });
    expect(response.statusCode, response.body).toBe(200);
  }
  it('installs an independent SDK server with reviewed effects, immutable pins and history', async () => {
    expect((await fixture.request('GET', '/api/mcp/servers', undefined, false)).statusCode).toBe(
      401,
    );
    const { body } = await install();
    expect(installation.configuration.permissions[1]!.effect).toBeNull();
    expect(installation.configuration.catalogue.tools[1]!.annotations.readOnlyHint).toBe(true);
    expect(JSON.stringify(installation)).not.toContain(token);
    const stale = await fixture.request('PUT', `/api/mcp/servers/${installation.id}`, {
      ...body,
      expectedVersion: 99,
    });
    expect(stale.statusCode).toBe(409);
    expect(
      await fixture.db.orm
        .select()
        .from(settingsHistory)
        .where(eq(settingsHistory.namespace, `mcp:${installation.id}`)),
    ).toHaveLength(1);
    expect(
      (
        await fixture.request(
          'POST',
          '/api/mcp/inspect',
          { projectId: fixture.projectId, transport: transport() },
          true,
          'https://foreign.example',
        )
      ).statusCode,
    ).toBe(403);
  });
  it('asks for an unmapped tool under Autonomous, then sends once through the authenticated worker gateway', async () => {
    const before = remote.state.calls,
      run = await mission();
    expect((await run.detail())!.mission.run.status).toBe('waiting_approval');
    expect(remote.state.calls).toBe(before);
    await approve(run);
    await run.executor.execute(run.created.run.id);
    const detail = (await run.detail())!;
    expect(detail.mission.run.status).toBe('completed');
    expect(detail.mission.run.tainted).toBe(true);
    expect(remote.state.calls).toBe(before + 1);
    expect(JSON.stringify(detail)).toContain('<untrusted>');
    await run.executor.execute(run.created.run.id);
    expect(remote.state.calls).toBe(before + 1);
    const persisted = await fixture.db.orm
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.runId, run.created.run.id));
    expect(persisted[0]!.status).toBe('done');
    expect(JSON.stringify({ detail, persisted, logs: fixture.logLines })).not.toContain(token);
  });
  it('executes an explicitly mapped read without approval and refuses changed tool schemas before calls', async () => {
    const read = await mission('read_marker');
    expect((await read.detail())!.mission.run.status).toBe('completed');
    const run = await mission(),
      before = remote.state.calls;
    await approve(run);
    remote.state.changeSchema = true;
    await run.executor.execute(run.created.run.id);
    expect(remote.state.calls).toBe(before);
    const current = mcpServerSchema.parse(
      (await fixture.request('GET', `/api/mcp/servers/${installation.id}`)).json(),
    );
    expect(current.warning).toContain('changed');
    await install(installation.id);
    expect(installation.version).toBe(2);
    expect((await selectedMcp(fixture.db, run.created.run.id))[0]!.version).toBe(1);
  });
  it('applies revocation before an approval can resume a pinned installation', async () => {
    const run = await mission(),
      before = remote.state.calls;
    const response = await fixture.request('POST', `/api/mcp/servers/${installation.id}/control`, {
      expectedVersion: installation.version,
      enabled: false,
    });
    installation = mcpServerSchema.parse(response.json());
    const approval = (await run.detail())!.approvals[0]!;
    expect(
      (
        await fixture.request('POST', `/api/approvals/${approval.id}/decision`, {
          version: approval.version,
          action: 'approve',
        })
      ).statusCode,
    ).toBe(400);
    expect(remote.state.calls).toBe(before);
    await install(installation.id);
  });
  it('keeps a lost acknowledgement uncertain across worker replay without repeating the effect', async () => {
    const run = await mission(),
      before = remote.state.calls;
    await approve(run);
    remote.state.drop = true;
    await run.executor.execute(run.created.run.id);
    expect((await run.detail())!.mission.run.status).toBe('waiting_approval');
    expect(remote.state.calls).toBe(before + 1);
    const receipts = await fixture.db.orm
      .select()
      .from(mcpCalls)
      .where(eq(mcpCalls.runId, run.created.run.id));
    expect(receipts[0]!.status).toBe('started');
    await fixture.db.orm
      .update(runs)
      .set({ status: 'queued' })
      .where(eq(runs.id, run.created.run.id));
    await run.executor.execute(run.created.run.id);
    expect(remote.state.calls).toBe(before + 1);
    expect(
      (await run.detail())!.approvals.some(
        (item) => item.kind === 'uncertain' && item.status === 'pending',
      ),
    ).toBe(true);
    const uncertain = (await run.detail())!.approvals.find((item) => item.kind === 'uncertain')!;
    expect(
      (
        await fixture.request('POST', `/api/approvals/${uncertain.id}/decision`, {
          version: uncertain.version,
          action: 'confirm_not_done',
          note: 'Fixture owner verified the remote outcome and explicitly authorizes another attempt.',
        })
      ).statusCode,
    ).toBe(200);
    await run.executor.execute(run.created.run.id);
    expect((await run.detail())!.mission.run.status).toBe('completed');
    expect(remote.state.calls).toBe(before + 2);
    await run.executor.execute(run.created.run.id);
    expect(remote.state.calls).toBe(before + 2);
    expect(
      await fixture.db.orm.select().from(mcpCalls).where(eq(mcpCalls.runId, run.created.run.id)),
    ).toHaveLength(2);
  });
  it('bounds catalogue pagination and refuses missing worker authentication', async () => {
    remote.state.repeatCursor = true;
    expect(
      (
        await fixture.request('POST', '/api/mcp/inspect', {
          projectId: fixture.projectId,
          transport: transport(),
        })
      ).statusCode,
    ).toBe(409);
    remote.state.repeatCursor = false;
    expect((await fixture.request('POST', '/internal/external-execution', {})).statusCode).not.toBe(
      200,
    );
  });
  it('refuses re-enablement when the active installation limit would be exceeded', async () => {
    const disabled = await fixture.request('POST', `/api/mcp/servers/${installation.id}/control`, {
      expectedVersion: installation.version,
      enabled: false,
    });
    installation = mcpServerSchema.parse(disabled.json());
    const ids: string[] = [];
    try {
      for (let index = 0; index < 20; index++) {
        const id = workKey('mcp');
        ids.push(id);
        const configuration = { ...installation.configuration, enabled: true, permissions: [] };
        await fixture.db.orm
          .insert(mcpServers)
          .values({ id, userId: fixture.userId, projectId: fixture.projectId });
        await fixture.db.orm.insert(mcpServerVersions).values({
          id: workKey('mcv'),
          serverId: id,
          version: 1,
          configuration: jsonValue(configuration),
          sha256: valueHash(configuration),
        });
      }
      const response = await fixture.request(
        'POST',
        `/api/mcp/servers/${installation.id}/control`,
        {
          expectedVersion: installation.version,
          enabled: true,
        },
      );
      expect(response.statusCode).toBe(409);
      expect(response.body).toContain('MCP_INVALID');
      expect(
        mcpServerSchema.parse(
          (await fixture.request('GET', `/api/mcp/servers/${installation.id}`)).json(),
        ).configuration.enabled,
      ).toBe(false);
    } finally {
      for (const id of ids) await fixture.db.orm.delete(mcpServers).where(eq(mcpServers.id, id));
    }
  });
});
