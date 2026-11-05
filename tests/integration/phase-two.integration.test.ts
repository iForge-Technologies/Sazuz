import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { migrateDatabase, saveSetting } from '@sazuz/db';
import { chatEventSchema, messageSchema, projectSchema, threadSchema } from '@sazuz/core/work';
import { createApp } from '../../apps/server/src/app.js';
import { createPhaseOne, type PhaseOne } from '../../apps/server/src/phase-one.js';
import { registerPhaseOne } from '../../apps/server/src/phase-one-routes.js';
import { createModelServices, registerPhaseTwo } from '../../apps/server/src/phase-two.js';
import { openIntegrationDatabase, type IntegrationDatabase } from './database-fixture.js';

describe('Phase 2 authenticated chat and ledger against PostgreSQL', () => {
  let fixture: IntegrationDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let runtime: PhaseOne;
  let directory: string;
  let owned = false;
  const cookies = new Map<string, string>();
  const calls: string[] = [];
  const origin = 'http://localhost:7777';
  const password = 'chat-admin-password-9821';
  const request = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
    auth = true,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: {
        origin,
        'content-type': 'application/json',
        ...(auth ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    if (auth) for (const c of response.cookies) cookies.set(c.name, c.value);
    return response;
  };
  beforeAll(async () => {
    fixture = await openIntegrationDatabase();
    await migrateDatabase(fixture.database);
    const occupied = await fixture.database.pool.query<{ count: number }>(
      'SELECT ((SELECT count(*) FROM installation)+(SELECT count(*) FROM users)+(SELECT count(*) FROM worker_heartbeats)+(SELECT count(*) FROM cost_ledger))::int AS count',
    );
    if (occupied.rows[0]?.count !== 0)
      throw new Error('Use an empty dedicated Phase 2 test database. Existing data was preserved.');
    directory = await mkdtemp(join(tmpdir(), 'sazuz-phase2-test-'));
    runtime = await createPhaseOne(fixture.database, { ...fixture.config, dataDir: directory });
    owned = true;
    app = await createApp({
      logger: fixture.logger,
      health: () =>
        Promise.resolve({
          status: 'ok',
          checkedAt: new Date().toISOString(),
          services: {
            database: { status: 'ok', latencyMs: 1 },
            worker: { status: 'ok', activeCount: 1, lastSeenAt: new Date().toISOString() },
          },
        }),
    });
    registerPhaseOne(app, runtime);
    const fakeFetch: typeof fetch = (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push(url.hostname + url.pathname);
      if (url.pathname.endsWith('/models'))
        return Promise.resolve(Response.json({ object: 'list', data: [{ id: 'llama3.2' }] }));
      const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
        `data: ${JSON.stringify({ id: 'fixture-chat', object: 'chat.completion.chunk', created: 1, model: 'llama3.2', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
      return Promise.resolve(
        new Response(
          chunk({ role: 'assistant', content: 'Hello from the model.' }, null) +
            chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }) +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    };
    registerPhaseTwo(app, runtime, createModelServices(runtime, { fetch: fakeFetch }));
    const token = (await import('node:fs/promises')).readFile(
      join(directory, 'secrets/setup-token'),
      'utf8',
    );
    expect(
      (await request('POST', '/api/setup/gate', { token: (await token).trim() })).statusCode,
    ).toBe(200);
    expect(
      (
        await request('POST', '/api/setup/admin', {
          name: 'Chat Owner',
          email: 'chat@example.test',
          password,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await request('POST', '/api/auth/sign-in/email', { email: 'chat@example.test', password }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await request('POST', '/api/vault/initialize', {
          passphrase: 'chat-vault-passphrase-2983',
          mode: 'auto',
        })
      ).statusCode,
    ).toBe(200);
    const providers = runtime.settings.providers;
    await saveSetting(fixture.database, {
      namespace: 'providers',
      expectedVersion: providers.version,
      actorId: 'test',
      value: {
        items: ['primary', 'fallback'].map((id) => ({
          id,
          name: id,
          kind: 'openai-compatible',
          baseUrl: `http://${id}.example/v1`,
          locality: 'local',
          secretRef: null,
          enabled: true,
        })),
      },
    });
    await vi.waitFor(() => expect(runtime.settings.providers.version).toBe(providers.version + 1));
    for (const id of ['primary', 'fallback'])
      expect((await request('POST', `/api/providers/${id}/discover`, {})).statusCode).toBe(200);
    const models = runtime.settings.models;
    await saveSetting(fixture.database, {
      namespace: 'models',
      expectedVersion: models.version,
      actorId: 'test',
      value: {
        ...models.value,
        roles: { ...models.value.roles, executor: { providerId: 'primary', modelId: 'llama3.2' } },
        fallbackOrder: ['fallback'],
      },
    });
    await vi.waitFor(() => expect(runtime.settings.models.version).toBe(models.version + 1));
  });
  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    if (owned)
      await fixture.database.pool.query(
        'DELETE FROM installation; DELETE FROM setup_sessions; DELETE FROM settings_history; DELETE FROM settings; TRUNCATE TABLE audit_log, audit_chain_state; DELETE FROM vault_meta; DELETE FROM secrets; DELETE FROM cost_ledger; DELETE FROM users; DELETE FROM verifications; DELETE FROM auth_rate_limits; DELETE FROM security_rate_limits; DELETE FROM models',
      );
    await fixture?.close();
    if (
      directory &&
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
      directory.includes('sazuz-phase2-test-')
    )
      await rm(directory, { recursive: true, force: true });
  });
  it('requires authentication and streams persisted messages with model usage', async () => {
    expect((await request('GET', '/api/projects', undefined, false)).statusCode).toBe(401);
    const project = projectSchema.parse(
      (
        await request('POST', '/api/projects', { name: 'Private Project', privacy: 'private' })
      ).json<unknown>(),
    );
    const thread = threadSchema.parse(
      (
        await request('POST', '/api/threads', { projectId: project.id, title: 'Conversation' })
      ).json<unknown>(),
    );
    const response = await request('POST', `/api/threads/${thread.id}/chat`, {
      content: 'Say hello',
      requestId: crypto.randomUUID(),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = response.body
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => chatEventSchema.parse(JSON.parse(frame.slice(6)) as unknown));
    expect(events.at(-1), response.body).toMatchObject({ type: 'run.status', status: 'completed' });
    const saved = z
      .array(messageSchema)
      .parse((await request('GET', `/api/threads/${thread.id}/messages`)).json<unknown>());
    expect(saved.find((row) => row.role === 'assistant')).toMatchObject({
      providerId: 'primary',
      modelId: 'llama3.2',
      inputTokens: 12,
      outputTokens: 5,
      costUsd: 0,
    });
    const primary = runtime.settings.providers;
    await saveSetting(fixture.database, {
      namespace: 'providers',
      expectedVersion: primary.version,
      actorId: 'test',
      value: {
        items: primary.value.items.map((provider) => ({
          ...provider,
          enabled: provider.id !== 'primary',
        })),
      },
    });
    await expect.poll(() => runtime.settings.providers.version).toBe(primary.version + 1);
    const requestId = crypto.randomUUID();
    const second = await request('POST', `/api/threads/${thread.id}/chat`, {
      content: 'Continue on the fallback',
      requestId,
    });
    expect(second.body).toContain('fallback');
    expect(second.body).toContain('completed');
    const before = calls.length;
    await request('POST', `/api/threads/${thread.id}/chat`, {
      content: 'Continue on the fallback',
      requestId,
    });
    expect(calls.length).toBe(before);
    const ledger = (
      await fixture.database.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM cost_ledger',
      )
    ).rows[0];
    expect(ledger?.count).toBe(2);
    expect((await request('GET', '/api/costs')).json<unknown>()).toMatchObject({
      inputTokens: 24,
      outputTokens: 10,
    });
  });
  it('generates with the selected model, records its usage, and preserves prices on discovery', async () => {
    const count = calls.filter((call) => call.endsWith('/chat/completions')).length;
    const tested = await request('POST', '/api/providers/fallback/test', { modelId: 'llama3.2' });
    expect(tested.statusCode, tested.body).toBe(200);
    expect(tested.json<unknown>()).toMatchObject({
      providerId: 'fallback',
      ok: true,
      code: 'READY',
    });
    expect(calls.filter((call) => call.endsWith('/chat/completions'))).toHaveLength(count + 1);
    const ledger = await fixture.database.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM cost_ledger WHERE agent_id='model-test'",
    );
    expect(ledger.rows[0]?.count).toBe(1);
    const version = runtime.settings.models.version;
    expect(
      (
        await request('PUT', '/api/models/prices', {
          providerId: 'fallback',
          modelId: 'llama3.2',
          price: { inputPerMTok: 0.12, outputPerMTok: 0.25 },
        })
      ).statusCode,
    ).toBe(200);
    await expect.poll(() => runtime.settings.models.version).toBe(version + 1);
    const discovered = await request('POST', '/api/providers/fallback/discover', {});
    expect(discovered.json<unknown>()).toMatchObject({
      models: [{ price: { inputPerMTok: 0.12, outputPerMTok: 0.25 } }],
    });
  });
});
