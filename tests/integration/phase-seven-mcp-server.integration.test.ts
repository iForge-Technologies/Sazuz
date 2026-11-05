import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mcpClientSchema, mcpIncomingToolSchema } from '@sazuz/core/mcp';
import {
  createMission,
  approvals,
  createProject,
  getControl,
  memories,
  missions,
  queueOutbox,
  readSettings,
  runs,
  saveSetting,
  setControl,
  workKey,
  valueHash,
} from '@sazuz/db';
import { registerPhaseSeven } from '../../apps/server/src/phase-seven.js';
import { phaseFourFixture } from './phase-four-fixture.js';

describe('Phase 7 incoming MCP delegation over real HTTP', () => {
  let fixture: Awaited<ReturnType<typeof phaseFourFixture>>, client: Client, address: string;
  let grant: z.infer<typeof mcpClientSchema>;
  const token = 'phase7-incoming-mcp-canary-038475621904',
    clients: Client[] = [];
  const resultSchema = z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  });
  const decoded = (value: unknown) =>
    z
      .record(z.string(), z.json())
      .parse(JSON.parse(resultSchema.parse(value).content[0]!.text) as unknown);
  async function connect(value: string) {
    const sdk = new Client(
      { name: 'independent-desktop-client', version: '1' },
      { capabilities: {} },
    );
    clients.push(sdk);
    await sdk.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { authorization: `Bearer ${value}` } },
      }),
    );
    return sdk;
  }
  beforeAll(async () => {
    fixture = await phaseFourFixture((app, runtime) => {
      registerPhaseSeven(app, runtime);
    });
    const secret = await fixture.runtime.vault.create({
      name: 'Incoming MCP',
      value: token,
      createdBy: fixture.userId,
    });
    const response = await fixture.request('POST', '/api/mcp/clients', {
      name: 'Independent desktop',
      projectId: fixture.projectId,
      secretRef: secret.reference,
      tools: mcpIncomingToolSchema.options,
    });
    expect(response.statusCode, response.body).toBe(200);
    grant = mcpClientSchema.parse(response.json());
    expect(response.body).not.toContain(token);
    address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    client = await connect(token);
  });
  afterAll(async () => {
    for (const sdk of clients) await sdk.close();
    await fixture?.close();
  });
  it('exposes exactly five scoped tools and lets an independent SDK client create/read/replay a real mission', async () => {
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
      [...mcpIncomingToolSchema.options].sort(),
    );
    const input = {
      requestId: randomUUID(),
      goal: 'Read the authorized project summary.',
      agent: 'researcher',
    };
    const created = decoded(await client.callTool({ name: 'create_mission', arguments: input }));
    expect(created.status).toBe('queued');
    expect(created.projectId).toBe(fixture.projectId);
    const replay = decoded(await client.callTool({ name: 'create_mission', arguments: input }));
    expect(replay.missionId).toBe(created.missionId);
    const status = decoded(
      await client.callTool({
        name: 'get_mission_status',
        arguments: { missionId: created.missionId },
      }),
    );
    expect(status.status).toBe('queued');
    expect(status.steps).toBe(0);
    const [mission] = await fixture.db.orm
      .select()
      .from(missions)
      .where(eq(missions.id, z.string().parse(created.missionId)));
    const [run] = await fixture.db.orm.select().from(runs).where(eq(runs.missionId, mission!.id));
    expect(mission!.source).toBe(`mcp:${grant.id}`);
    expect(mission!.goal).toContain('<untrusted>');
    expect(run!.tainted).toBe(true);
    expect(
      await fixture.db.orm.select().from(queueOutbox).where(eq(queueOutbox.runId, run!.id)),
    ).toHaveLength(1);
    expect(
      resultSchema.parse(
        await client.callTool({
          name: 'create_mission',
          arguments: { ...input, goal: 'Retarget the same request.' },
        }),
      ).isError,
    ).toBe(true);
  });
  it('keeps another project, global/agent/private memories, and undelegated operations out of scope', async () => {
    const other = await createProject(fixture.db, fixture.userId, { name: 'Outside MCP grant' });
    const outside = await createMission(
      fixture.db,
      fixture.userId,
      { projectId: other.id, goal: 'Outside grant', requestId: randomUUID() },
      { maxSteps: 5, maxCostUsd: 1, maxWallTimeSeconds: 60 },
    );
    expect(
      resultSchema.parse(
        await client.callTool({ name: 'get_mission_status', arguments: { missionId: outside.id } }),
      ).isError,
    ).toBe(true);
    for (const entry of [
      {
        projectId: fixture.projectId,
        agentId: null,
        scope: 'project',
        sensitivity: 'low',
        content: 'project-visible-marker',
      },
      {
        projectId: fixture.projectId,
        agentId: null,
        scope: 'project',
        sensitivity: 'private',
        content: 'private-hidden-marker',
      },
      {
        projectId: null,
        agentId: null,
        scope: 'global',
        sensitivity: 'low',
        content: 'global-hidden-marker',
      },
      {
        projectId: fixture.projectId,
        agentId: 'cos',
        scope: 'agent',
        sensitivity: 'low',
        content: 'agent-hidden-marker',
      },
      {
        projectId: other.id,
        agentId: null,
        scope: 'project',
        sensitivity: 'low',
        content: 'other-hidden-marker',
      },
    ])
      await fixture.db.orm.insert(memories).values({
        id: workKey('mem'),
        userId: fixture.userId,
        kind: 'fact',
        status: 'accepted',
        ...entry,
      });
    const result = resultSchema.parse(
      await client.callTool({ name: 'search_memory', arguments: { query: '' } }),
    );
    expect(result.content[0]!.text).toContain('project-visible-marker');
    expect(result.content[0]!.text).not.toContain('hidden-marker');
    expect(result.content[0]!.text).toContain('<untrusted>');
    expect(
      resultSchema.parse(
        await client.callTool({ name: 'search_kb', arguments: { query: 'no existing document' } }),
      ).isError,
    ).not.toBe(true);
    expect(
      resultSchema.parse(await client.callTool({ name: 'list_approvals', arguments: {} })).content,
    ).toHaveLength(1);
    expect(
      resultSchema.parse(await client.callTool({ name: 'approve', arguments: {} })).isError,
    ).toBe(true);
    const limitedToken = 'phase7-readonly-mcp-credential-13487502';
    const secret = await fixture.runtime.vault.create({
      name: 'Read-only MCP',
      value: limitedToken,
      createdBy: fixture.userId,
    });
    expect(
      (
        await fixture.request('POST', '/api/mcp/clients', {
          name: 'Read only',
          projectId: fixture.projectId,
          secretRef: secret.reference,
          tools: ['get_mission_status'],
        })
      ).statusCode,
    ).toBe(200);
    const limited = await connect(limitedToken);
    expect((await limited.listTools()).tools.map((tool) => tool.name)).toEqual([
      'get_mission_status',
    ]);
    expect(
      resultSchema.parse(
        await limited.callTool({
          name: 'create_mission',
          arguments: { requestId: randomUUID(), goal: 'Unauthorized' },
        }),
      ).isError,
    ).toBe(true);
  });
  it('stages cautious delegations without an outbox and obeys the global kill switch', async () => {
    const settings = await readSettings(fixture.db);
    await saveSetting(fixture.db, {
      namespace: 'security',
      expectedVersion: settings.security.version,
      actorId: fixture.userId,
      value: { ...settings.security.value, preset: 'cautious' },
    });
    await expect.poll(() => fixture.runtime.settings.security.value.preset).toBe('cautious');
    const created = decoded(
      await client.callTool({
        name: 'create_mission',
        arguments: { requestId: randomUUID(), goal: 'Needs explicit owner review' },
      }),
    );
    expect(created.status).toBe('paused');
    const [run] = await fixture.db.orm
      .select()
      .from(runs)
      .where(eq(runs.missionId, z.string().parse(created.missionId)));
    expect(
      await fixture.db.orm.select().from(queueOutbox).where(eq(queueOutbox.runId, run!.id)),
    ).toHaveLength(0);
    await setControl(fixture.db, fixture.userId, true, (await getControl(fixture.db)).version);
    expect(
      resultSchema.parse(
        await client.callTool({
          name: 'create_mission',
          arguments: { requestId: randomUUID(), goal: 'Blocked by kill switch' },
        }),
      ).isError,
    ).toBe(true);
    await setControl(fixture.db, fixture.userId, false, (await getControl(fixture.db)).version);
  });
  it('withholds run explanations and approval content from clients without private permission', async () => {
    const marker = 'private-run-content-marker';
    const mission = await createMission(
      fixture.db,
      fixture.userId,
      {
        projectId: fixture.projectId,
        goal: 'Private evidence fixture',
        requestId: randomUUID(),
      },
      { maxSteps: 5, maxCostUsd: 1, maxWallTimeSeconds: 60 },
    );
    await fixture.db.orm.update(runs).set({ reason: marker }).where(eq(runs.id, mission.run.id));
    await fixture.db.orm.insert(approvals).values({
      id: workKey('apr'),
      runId: mission.run.id,
      callKey: `${mission.run.id}:1:0`,
      agentId: 'cos',
      toolName: 'files.write',
      args: { content: marker },
      argsHash: valueHash({ content: marker }),
      effect: 'write',
      reason: marker,
      risk: 'medium',
      ruleId: 'fixture',
      tainted: true,
      expiresAt: new Date(Date.now() + 60000),
    });
    const status = await client.callTool({
      name: 'get_mission_status',
      arguments: { missionId: mission.id },
    });
    expect(decoded(status).reason).toBeNull();
    const pending = resultSchema.parse(
      await client.callTool({ name: 'list_approvals', arguments: {} }),
    );
    expect(pending.isError).not.toBe(true);
    expect(pending.content[0]!.text).toContain('files.write');
    expect(JSON.stringify({ status, pending })).not.toContain(marker);
  });
  it('checks bearer authorization on every request, revokes live clients and excludes credential canaries', async () => {
    expect(
      (
        await fetch(`${address}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fixture.request('POST', `/api/mcp/clients/${grant.id}/control`, {
          expectedVersion: grant.version,
          enabled: false,
        })
      ).statusCode,
    ).toBe(200);
    await expect(client.listTools()).rejects.toThrow();
    const response = await fixture.request('GET', '/api/mcp/clients');
    expect(response.body).not.toContain(token);
    expect(fixture.logLines.join('\n')).not.toContain(token);
    expect((await fixture.db.orm.select().from(missions)).length).toBeGreaterThan(0);
  });
});
