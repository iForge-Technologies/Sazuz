import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agentRevisionSchema, agentSummarySchema } from '@sazuz/core/agents';
import { auditLog, approvals, createMission, getMission, toolCalls } from '@sazuz/db';
import {
  agentActionPermission,
  getAgent,
  pinAgent,
  saveAgent,
} from '../../packages/orchestrator/src/index.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { decideApproval } from '../../packages/runtime/src/durable-store.js';
import { createConnectorTools } from '../../packages/connectors/src/index.js';
import { ToolRegistry } from '../../packages/tools/src/index.js';
import { registerPhaseSix } from '../../apps/server/src/phase-six.js';
import { phaseFourFixture } from './phase-four-fixture.js';
import { createFixtureRouter } from './phase-three-runtime-worker.js';

describe('Phase 6 owned identities and execution grants', () => {
  let fixture: Awaited<ReturnType<typeof phaseFourFixture>>;
  beforeAll(async () => {
    fixture = await phaseFourFixture(registerPhaseSix);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  const limits = { maxSteps: 12, maxCostUsd: 1, maxWallTimeSeconds: 120 };
  it('serves ten agents only to the owner; saves immutable revisions with stale-write refusal and rollback', async () => {
    expect((await fixture.request('GET', '/api/agents', undefined, false)).statusCode).toBe(401);
    const response = await fixture.request('GET', '/api/agents');
    const list = z.array(agentSummarySchema).parse(response.json());
    expect(list).toHaveLength(10);
    const before = agentRevisionSchema.parse(
      (await fixture.request('GET', '/api/agents/writer')).json(),
    );
    const input = {
      expectedVersion: before.version,
      definition: {
        ...before.definition,
        instructions: 'Write short paragraphs with a source for each claim.',
      },
    };
    const updated = await fixture.request('PUT', '/api/agents/writer', input);
    expect(updated.statusCode).toBe(200);
    expect(agentRevisionSchema.parse(updated.json()).version).toBe(2);
    expect((await fixture.request('PUT', '/api/agents/writer', input)).statusCode).toBe(409);
    expect((await getAgent(fixture.db, fixture.userId, 'writer', 1)).definition.instructions).toBe(
      before.definition.instructions,
    );
    const restored = await fixture.request('POST', '/api/agents/writer/rollback', {
      expectedVersion: 2,
      version: 1,
    });
    expect(agentRevisionSchema.parse(restored.json()).version).toBe(3);
    expect(
      (
        await fixture.request('PUT', '/api/agents/writer', {
          expectedVersion: 3,
          yaml: 'id: &a [*a]',
        })
      ).statusCode,
    ).toBe(400);
    await expect(getAgent(fixture.db, 'different-owner', 'writer')).rejects.toThrow('unavailable');
  });
  it('pins instructions and prevents grants added later from widening a running agent', async () => {
    const mission = await createMission(
      fixture.db,
      fixture.userId,
      {
        projectId: fixture.projectId,
        goal: 'Scope test',
        agent: 'researcher',
        requestId: randomUUID(),
      },
      limits,
    );
    const before = await getAgent(fixture.db, fixture.userId, 'researcher');
    await pinAgent(fixture.db, fixture.userId, mission.run.id, 'researcher', []);
    await saveAgent(
      fixture.db,
      fixture.userId,
      'researcher',
      {
        expectedVersion: before.version,
        definition: {
          ...before.definition,
          tools: [...before.definition.tools, 'gmail.send'],
          permissions: { preset: 'inherit', deny: [] },
        },
      },
      [],
    );
    expect(
      await agentActionPermission(
        fixture.db,
        fixture.userId,
        mission.run.id,
        'researcher',
        'gmail.send',
        { accountId: 'mail' },
        'send',
        [],
      ),
    ).toBe(false);
  });
  it('logs and denies a real Gmail tool attempt before any credential, transport, intent or approval', async () => {
    const account = {
      id: 'phase6-mail',
      name: 'Disposable Gmail',
      kind: 'email' as const,
      provider: 'gmail' as const,
      mode: 'read-write' as const,
      scopes: ['email:send'],
      secretRef: 'secret://sec_00000000000000000000000001',
      options: {},
    };
    const settings = structuredClone(fixture.runtime.settings);
    settings.connectors.value.accounts = [account];
    const transport = vi.fn<typeof fetch>(),
      secret = vi.fn(() => Promise.reject(new Error('Credential resolution must not happen.')));
    const tools = new ToolRegistry(
      createConnectorTools({
        getAccounts: () => settings.connectors.value.accounts,
        fetch: transport,
      }),
    );
    const mission = await createMission(
      fixture.db,
      fixture.userId,
      {
        projectId: fixture.projectId,
        goal: 'Try sending without a Gmail grant.',
        agent: 'researcher',
        requestId: randomUUID(),
      },
      limits,
    );
    const execute = createDurableExecutor({
      database: fixture.db,
      workerId: 'phase6-scope',
      dataDir: fixture.directory,
      getSettings: () => settings,
      tools,
      secret,
      router: () =>
        createFixtureRouter({
          toolName: 'gmail.send',
          args: {
            accountId: account.id,
            to: ['fixture@example.test'],
            subject: 'Permission check',
            text: 'Fixture only.',
          },
        }),
    });
    await execute.execute(mission.run.id);
    const detail = await getMission(fixture.db, fixture.userId, mission.id);
    expect(detail?.mission.run.status).toBe('completed');
    expect(detail?.steps.find((step) => step.toolName === 'gmail.send')?.content).toContain(
      'denied',
    );
    expect(transport).not.toHaveBeenCalled();
    expect(secret).not.toHaveBeenCalled();
    expect(
      await fixture.db.orm.select().from(toolCalls).where(eq(toolCalls.runId, mission.run.id)),
    ).toHaveLength(0);
    expect(
      await fixture.db.orm.select().from(approvals).where(eq(approvals.runId, mission.run.id)),
    ).toHaveLength(0);
    const log = await fixture.db.orm
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'policy.deny'),
          eq(auditLog.target, mission.run.id + ':gmail.send:agent-scope'),
        ),
      );
    expect(log).toHaveLength(1);
    expect(log[0]?.actorId).toContain('Researcher (Sazuz) (on behalf of');
  });
  it('revokes a previously granted account before an approval can resume execution', async () => {
    const account = {
      id: 'phase6-mail',
      name: 'Disposable Gmail',
      kind: 'email' as const,
      provider: 'gmail' as const,
      mode: 'read-write' as const,
      scopes: ['email:send'],
      secretRef: 'secret://sec_00000000000000000000000001',
      options: {},
    };
    const settings = structuredClone(fixture.runtime.settings);
    settings.connectors.value.accounts = [account];
    const original = await getAgent(fixture.db, fixture.userId, 'comms');
    const granted = await saveAgent(
      fixture.db,
      fixture.userId,
      'comms',
      {
        expectedVersion: original.version,
        definition: {
          ...original.definition,
          identity: {
            ...original.definition.identity,
            connector_accounts: [{ accountId: account.id, permissions: ['email:send'] }],
          },
        },
      },
      [account],
    );
    const transport = vi.fn<typeof fetch>();
    const tools = new ToolRegistry(
      createConnectorTools({
        getAccounts: () => settings.connectors.value.accounts,
        fetch: transport,
      }),
    );
    const mission = await createMission(
      fixture.db,
      fixture.userId,
      {
        projectId: fixture.projectId,
        goal: 'Draft an approval.',
        agent: 'comms',
        requestId: randomUUID(),
      },
      limits,
    );
    const executor = createDurableExecutor({
      database: fixture.db,
      workerId: 'phase6-revoke',
      dataDir: fixture.directory,
      getSettings: () => settings,
      tools,
      router: () =>
        createFixtureRouter({
          toolName: 'gmail.send',
          args: {
            accountId: account.id,
            to: ['fixture@example.test'],
            subject: 'Review',
            text: 'Fixture only.',
          },
        }),
    });
    await executor.execute(mission.run.id);
    const [approval] = await fixture.db.orm
      .select()
      .from(approvals)
      .where(eq(approvals.runId, mission.run.id));
    expect(approval?.status).toBe('pending');
    await saveAgent(
      fixture.db,
      fixture.userId,
      'comms',
      {
        expectedVersion: granted.version,
        definition: {
          ...granted.definition,
          identity: { ...granted.definition.identity, connector_accounts: [] },
        },
      },
      [account],
    );
    await expect(
      decideApproval(
        fixture.db,
        fixture.userId,
        approval!.id,
        { version: approval!.version, action: 'approve' },
        tools,
        () => settings,
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    expect(transport).not.toHaveBeenCalled();
  });
});
