import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { connectorCatalogueSchema } from '@sazuz/core/connectors';
import {
  auditLog,
  approvals,
  createMission,
  getMission,
  readSettings,
  saveSetting,
  settingsHistory,
  toolCalls,
  oauthStates,
} from '@sazuz/db';
import {
  getAgent,
  saveAgent,
  pinAgent,
  agentActionPermission,
  ensureAgents,
} from '../../packages/orchestrator/src/index.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { decideApproval } from '../../packages/runtime/src/durable-store.js';
import { createConnectorTools } from '../../packages/connectors/src/index.js';
import { ToolRegistry } from '../../packages/tools/src/index.js';
import { phaseFourFixture } from './phase-four-fixture.js';
import { createFixtureRouter } from './phase-three-runtime-worker.js';

describe('Phase 7 native accounts, policy and OAuth state', () => {
  let fixture: Awaited<ReturnType<typeof phaseFourFixture>>;
  const canary = 'phase7-slack-credential-canary-175492';
  let reference: string;
  beforeAll(async () => {
    fixture = await phaseFourFixture();
    await ensureAgents(fixture.db, fixture.userId, []);
    reference = (
      await fixture.runtime.vault.create({
        name: 'Phase 7 token',
        value: canary,
        createdBy: fixture.userId,
      })
    ).reference;
  });
  afterAll(async () => {
    await fixture?.close();
  });
  function account() {
    return {
      id: 'phase7-slack',
      name: 'Scoped Slack',
      kind: 'chat' as const,
      provider: 'slack' as const,
      mode: 'read-write' as const,
      scopes: ['slack:read', 'slack:send'],
      secretRef: reference,
      options: { channelId: 'channel1' },
    };
  }
  it('authenticates the catalogue and versions native account/resource settings without plaintext credentials', async () => {
    expect(
      (await fixture.request('GET', '/api/connectors/catalogue', undefined, false)).statusCode,
    ).toBe(401);
    const catalogue = connectorCatalogueSchema.parse(
      (await fixture.request('GET', '/api/connectors/catalogue')).json(),
    );
    expect(catalogue).toHaveLength(18);
    const settings = await readSettings(fixture.db);
    const input = {
      expectedVersion: settings.connectors.version,
      value: { accounts: [account()] },
    };
    const response = await fixture.request('PUT', '/api/settings/connectors', input);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(canary);
    expect((await fixture.request('PUT', '/api/settings/connectors', input)).statusCode).toBe(409);
    expect(
      (
        await fixture.request(
          'PUT',
          '/api/settings/connectors',
          input,
          true,
          'https://foreign.example',
        )
      ).statusCode,
    ).toBe(403);
    const history = await fixture.db.orm
      .select()
      .from(settingsHistory)
      .where(eq(settingsHistory.namespace, 'connectors'));
    expect(history).toHaveLength(2);
    expect(JSON.stringify(history)).not.toContain(canary);
  });
  it('requires approval before Slack send, persists one result and excludes secrets on replay', async () => {
    const settings = await readSettings(fixture.db);
    const current = await getAgent(fixture.db, fixture.userId, 'comms');
    await saveAgent(
      fixture.db,
      fixture.userId,
      'comms',
      {
        expectedVersion: current.version,
        definition: {
          ...current.definition,
          tools: [...current.definition.tools, 'slack.*'],
          identity: {
            ...current.definition.identity,
            connector_accounts: [
              { accountId: account().id, permissions: ['slack:read', 'slack:send'] },
            ],
          },
        },
      },
      settings.connectors.value.accounts,
    );
    const transport = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ ok: true, channel: 'channel1', ts: '123.45' })),
    );
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
        agent: 'comms',
        goal: 'Send the reviewed fixture message.',
        requestId: randomUUID(),
      },
      { maxSteps: 12, maxCostUsd: 1, maxWallTimeSeconds: 180 },
    );
    const executor = createDurableExecutor({
      database: fixture.db,
      workerId: 'phase7-native',
      dataDir: fixture.directory,
      getSettings: () => settings,
      tools,
      secret: (_reference, _scope, consume) => consume(canary),
      router: () =>
        createFixtureRouter({
          toolName: 'slack.send',
          args: { accountId: account().id, text: 'Reviewed fixture message.' },
        }),
    });
    await executor.execute(mission.run.id);
    expect(transport).not.toHaveBeenCalled();
    const [approval] = await fixture.db.orm
      .select()
      .from(approvals)
      .where(eq(approvals.runId, mission.run.id));
    expect(approval?.status).toBe('pending');
    await decideApproval(
      fixture.db,
      fixture.userId,
      approval!.id,
      { version: approval!.version, action: 'approve' },
      tools,
      () => settings,
    );
    await executor.execute(mission.run.id);
    await executor.execute(mission.run.id);
    expect(transport).toHaveBeenCalledTimes(1);
    const detail = await getMission(fixture.db, fixture.userId, mission.id);
    expect(detail?.mission.run.status).toBe('completed');
    expect(detail?.mission.run.tainted).toBe(true);
    const calls = await fixture.db.orm
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.runId, mission.run.id));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('done');
    expect(JSON.stringify({ detail, calls, logs: fixture.logLines })).not.toContain(canary);
  });
  it('pins an account resource so changing its channel cannot redirect an already admitted run', async () => {
    const settings = await readSettings(fixture.db);
    const mission = await createMission(
      fixture.db,
      fixture.userId,
      {
        projectId: fixture.projectId,
        agent: 'comms',
        goal: 'Keep the channel scope.',
        requestId: randomUUID(),
      },
      { maxSteps: 12, maxCostUsd: 1, maxWallTimeSeconds: 180 },
    );
    await pinAgent(
      fixture.db,
      fixture.userId,
      mission.run.id,
      'comms',
      settings.connectors.value.accounts,
    );
    const check = (accounts: typeof settings.connectors.value.accounts) =>
      agentActionPermission(
        fixture.db,
        fixture.userId,
        mission.run.id,
        'comms',
        'slack.send',
        { accountId: account().id },
        'send',
        accounts,
      );
    expect(await check(settings.connectors.value.accounts)).toBe(true);
    expect(await check([{ ...account(), options: { channelId: 'outside-channel' } }])).toBe(false);
    expect(
      await check([{ ...account(), secretRef: 'secret://sec_00000000000000000000000009' }]),
    ).toBe(false);
  });
  it('refuses a current account-grant revocation before a waiting approval resumes', async () => {
    const settings = await readSettings(fixture.db);
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
        agent: 'comms',
        goal: 'A revocable draft.',
        requestId: randomUUID(),
      },
      { maxSteps: 12, maxCostUsd: 1, maxWallTimeSeconds: 180 },
    );
    const executor = createDurableExecutor({
      database: fixture.db,
      workerId: 'phase7-revoke',
      dataDir: fixture.directory,
      getSettings: () => settings,
      tools,
      router: () =>
        createFixtureRouter({
          toolName: 'slack.send',
          args: { accountId: account().id, text: 'Draft.' },
        }),
    });
    await executor.execute(mission.run.id);
    const [approval] = await fixture.db.orm
      .select()
      .from(approvals)
      .where(eq(approvals.runId, mission.run.id));
    expect(approval?.status).toBe('pending');
    const current = await getAgent(fixture.db, fixture.userId, 'comms');
    await saveAgent(
      fixture.db,
      fixture.userId,
      'comms',
      {
        expectedVersion: current.version,
        definition: {
          ...current.definition,
          identity: { ...current.definition.identity, connector_accounts: [] },
        },
      },
      settings.connectors.value.accounts,
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
    expect(
      await fixture.db.orm.select().from(toolCalls).where(eq(toolCalls.runId, mission.run.id)),
    ).toHaveLength(0);
  });
  it('denies an ungranted native account and records attributable policy evidence', async () => {
    const settings = await readSettings(fixture.db);
    const transport = vi.fn<typeof fetch>();
    const current = await getAgent(fixture.db, fixture.userId, 'researcher');
    await saveAgent(
      fixture.db,
      fixture.userId,
      'researcher',
      {
        expectedVersion: current.version,
        definition: { ...current.definition, tools: [...current.definition.tools, 'slack.send'] },
      },
      settings.connectors.value.accounts,
    );
    const mission = await createMission(
      fixture.db,
      fixture.userId,
      {
        projectId: fixture.projectId,
        agent: 'researcher',
        goal: 'Attempt an ungranted channel.',
        requestId: randomUUID(),
      },
      { maxSteps: 12, maxCostUsd: 1, maxWallTimeSeconds: 180 },
    );
    const executor = createDurableExecutor({
      database: fixture.db,
      workerId: 'phase7-denied',
      dataDir: fixture.directory,
      getSettings: () => settings,
      tools: new ToolRegistry(
        createConnectorTools({
          getAccounts: () => settings.connectors.value.accounts,
          fetch: transport,
        }),
      ),
      router: () =>
        createFixtureRouter({
          toolName: 'slack.send',
          args: { accountId: account().id, text: 'Should not send.' },
        }),
    });
    await executor.execute(mission.run.id);
    expect(transport).not.toHaveBeenCalled();
    const evidence = await fixture.db.orm
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'policy.deny'),
          eq(auditLog.target, mission.run.id + ':slack.send:agent-scope'),
        ),
      );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.actorId).toContain('Researcher');
  });
  it('binds Microsoft PKCE attempts to the owner, provider, connector version and vault verifier', async () => {
    const settings = await readSettings(fixture.db);
    await saveSetting(fixture.db, {
      namespace: 'connectors',
      actorId: fixture.userId,
      expectedVersion: settings.connectors.version,
      value: {
        accounts: [
          ...settings.connectors.value.accounts,
          {
            id: 'phase7-ms',
            name: 'Microsoft',
            kind: 'productivity',
            provider: 'microsoft-graph',
            mode: 'read',
            scopes: ['outlook:read'],
            secretRef: null,
            options: {
              oauthClientId: 'client1',
              oauthClientSecretRef: reference,
              oauthRedirectUri: 'http://localhost:7777/oauth/microsoft/callback',
            },
          },
        ],
      },
    });
    const saved = await readSettings(fixture.db);
    const response = await fixture.request(
      'POST',
      '/api/connectors/phase7-ms/oauth/microsoft/start',
      { version: saved.connectors.version },
    );
    expect(response.statusCode).toBe(200);
    const result = z.object({ authorizationUrl: z.url() }).parse(response.json());
    const url = new URL(result.authorizationUrl);
    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const rows = await fixture.db.orm
      .select()
      .from(oauthStates)
      .where(eq(oauthStates.accountId, 'phase7-ms'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe('microsoft');
    expect(rows[0]?.verifierRef).toMatch(/^secret:\/\/sec_/);
    const wrong = await fixture.request(
      'GET',
      `/oauth/google/callback?state=${url.searchParams.get('state')}&code=wrong-provider-code`,
    );
    expect(wrong.statusCode).toBe(303);
    expect(
      await fixture.db.orm.select().from(oauthStates).where(eq(oauthStates.accountId, 'phase7-ms')),
    ).toHaveLength(1);
    expect(JSON.stringify({ rows, response: response.body })).not.toContain(canary);
  });
});
