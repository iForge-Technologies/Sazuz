import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  browserActions,
  browserSessions,
  controlRun,
  createMission,
  getControl,
  getMission,
  recordHeartbeat,
  runs,
  runSteps,
  secrets,
  setControl,
  toolCalls,
} from '@sazuz/db';
import {
  browserLiveMessageSchema,
  browserSessionSchema,
  type BrowserHumanInput,
  type BrowserObservation,
} from '@sazuz/core/browser';
import { createBrowserTools, workerBrowserImage, workerBrowserTransport } from '@sazuz/browser';
import { browserImageRequestSchema, browserSocketText } from '@sazuz/browser/protocol';
import { checkpointSchema } from '../../packages/runtime/src/contracts.js';
import { durableCheckpointSchema } from '../../packages/runtime/src/durable-contracts.js';
import { ToolRegistry } from '../../packages/tools/src/registry.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { decideApproval } from '../../packages/runtime/src/durable-store.js';
import { startWebLiveGateway } from '../../scripts/web-live-gateway.js';
import { browserCanary, browserFixture } from './phase-five-fixture.js';

const origin = 'http://localhost:7777';
describe('Phase 5 public live control and assembled Operator acceptance', () => {
  let fixture: Awaited<ReturnType<typeof browserFixture>>;
  let web: Awaited<ReturnType<typeof startWebLiveGateway>>;
  let serverUrl: string, liveOrigin: string;
  const sockets: WebSocket[] = [];
  beforeAll(async () => {
    fixture = await browserFixture();
    serverUrl = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    web = await startWebLiveGateway({ serverUrl }, 0);
    liveOrigin = `ws://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    await web?.close();
    await fixture?.close();
  });
  function connect(id: string, cookie = fixture.cookieHeader(), source = origin) {
    const socket = new WebSocket(`${liveOrigin}/live/browser/${id}`, {
      headers: { cookie, origin: source },
      handshakeTimeout: 5000,
    });
    sockets.push(socket);
    return socket;
  }
  async function viewer(id: string) {
    const socket = connect(id);
    let frames = 0,
      states = 0,
      inputAllowed = false;
    const errors: string[] = [];
    socket.on('error', () => errors.push('connection failed'));
    socket.on('message', (data) => {
      const message = browserLiveMessageSchema.parse(JSON.parse(browserSocketText(data)));
      if (message.type === 'frame') {
        expect(Buffer.from(message.data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');
        frames++;
      } else if (message.type === 'state') {
        inputAllowed = message.inputAllowed;
        states++;
      }
    });
    await vi.waitFor(
      () => {
        expect(errors).toEqual([]);
        expect(frames).toBeGreaterThan(0);
      },
      { timeout: 10000 },
    );
    return {
      socket,
      get frames() {
        return frames;
      },
      get inputAllowed() {
        return inputAllowed;
      },
      get states() {
        return states;
      },
    };
  }
  async function send(socket: WebSocket, value: BrowserHumanInput) {
    await new Promise<void>((resolve, reject) =>
      socket.send(JSON.stringify(value), (error) => (error ? reject(error) : resolve())),
    );
  }
  async function press(socket: WebSocket, key: string) {
    await send(socket, { type: 'key', event: 'keyDown', key, code: key, modifiers: 0 });
    await send(socket, { type: 'key', event: 'keyUp', key, code: key, modifiers: 0 });
  }
  it('completes a multi-page form after human login, explicit handback and policy approvals without leaking the canary', async () => {
    const profile = await fixture.gateway.profiles.create(fixture.userId, {
      projectId: fixture.projectId,
      agentId: 'operator',
      name: 'Live acceptance',
      site: 'https://fixture.example',
    });
    const mission = await createMission(
      fixture.db,
      fixture.userId,
      {
        projectId: fixture.projectId,
        agent: 'operator',
        goal: `Complete the project form with profile ${profile.id}.`,
        requestId: randomUUID(),
      },
      { maxSteps: 30, maxCostUsd: 1, maxWallTimeSeconds: 600 },
    );
    let latest: BrowserObservation | undefined,
      generations = 0;
    const prompts: unknown[] = [];
    const transport = workerBrowserTransport({
      config: { ...fixture.runtime.config, serverUrl },
      workerId: fixture.workerId,
      key: () => Promise.resolve(fixture.runtime.plumbing.operatorKey),
    });
    const tools = new ToolRegistry(
      createBrowserTools({
        request: async (...args) => {
          await recordHeartbeat(fixture.db, fixture.workerId);
          const result = await transport.request(...args);
          latest = result.observation;
          return result;
        },
      }),
    );
    const element = (name: string) => {
      const target = latest?.elements.find((value) => value.name.includes(name));
      if (!target) throw new Error(`Missing acceptance element: ${name}`);
      return target.ref;
    };
    const executor = createDurableExecutor({
      database: fixture.db,
      workerId: fixture.workerId,
      dataDir: fixture.directory,
      getSettings: () => fixture.runtime.settings,
      tools,
      router: () => ({
        generate(request) {
          prompts.push(request.messages);
          generations++;
          const sessionId = latest?.sessionId;
          const next =
            generations === 1
              ? { name: 'browser.open', args: { profileId: profile.id } }
              : generations === 2
                ? {
                    name: 'browser.navigate',
                    args: { sessionId, url: 'https://fixture.example/login' },
                  }
                : generations === 3
                  ? { name: 'browser.read', args: { sessionId } }
                  : generations === 4
                    ? {
                        name: 'browser.type',
                        args: {
                          sessionId,
                          ref: element('Project name'),
                          value: { text: 'Launch project' },
                        },
                      }
                    : generations === 5
                      ? {
                          name: 'browser.select',
                          args: { sessionId, ref: element('Region'), values: ['West'] },
                        }
                      : generations === 6
                        ? { name: 'browser.click', args: { sessionId, ref: element('Review') } }
                        : generations === 7
                          ? {
                              name: 'browser.click',
                              args: { sessionId, ref: element('Submit project') },
                            }
                          : generations === 8
                            ? { name: 'browser.screenshot', args: { sessionId } }
                            : null;
          return Promise.resolve({
            text: next ? 'Continue the authorized form.' : 'Project submitted: fixture-42.',
            toolCalls: next ? [{ id: `live-${generations}`, ...next }] : [],
            finishReason: next ? ('tool-calls' as const) : ('stop' as const),
            providerId: 'fixture',
            modelId: 'fixture',
            costUsd: 0,
            costEstimated: false,
            latencyMs: 1,
            usage: {
              inputTokens: 10,
              outputTokens: 10,
              cachedInputTokens: 0,
              source: 'provider' as const,
            },
          });
        },
        generateObject: () => Promise.reject(new Error('This Operator does not plan.')),
      }),
    });
    async function advance(status: 'paused' | 'completed') {
      for (let attempt = 0; attempt < 24; attempt++) {
        await executor.execute(mission.run.id);
        const detail = (await getMission(fixture.db, fixture.userId, mission.id))!;
        if (detail.mission.run.status === status) return detail;
        const approval = detail.approvals.find((item) => item.status === 'pending');
        expect(approval, detail.mission.run.reason ?? detail.mission.run.status).toBeDefined();
        await decideApproval(
          fixture.db,
          fixture.userId,
          approval!.id,
          { action: 'approve', version: approval!.version, note: '' },
          tools,
          () => fixture.runtime.settings,
        );
      }
      throw new Error('The acceptance mission did not reach the expected state.');
    }
    const paused = await advance('paused');
    expect(generations).toBe(2);
    expect(paused.mission.run.tainted).toBe(true);
    const [active] = await fixture.db.orm
      .select()
      .from(browserSessions)
      .where(and(eq(browserSessions.runId, mission.run.id), eq(browserSessions.status, 'active')));
    const id = active!.id;
    let live = await viewer(id);
    const taken = await fixture.request('POST', `/api/browser/sessions/${id}/control`, {
      action: 'take',
      version: active!.version,
    });
    expect(taken.statusCode).toBe(200);
    const control = z.object({ session: browserSessionSchema }).parse(taken.json());
    await vi.waitFor(() => expect(live.inputAllowed).toBe(true));
    const page = fixture.service.engine.sessions
      .get(id)!
      .context.pages()
      .find((page) => page.url().endsWith('/login'))!;
    const box = (await page.getByLabel('Username').boundingBox())!;
    for (const event of ['mousePressed', 'mouseReleased'] as const)
      await send(live.socket, {
        type: 'pointer',
        event,
        x: box.x + 5,
        y: box.y + 5,
        button: 'left',
        deltaY: 0,
      });
    await send(live.socket, { type: 'text', text: 'fixture-owner' });
    await vi.waitFor(async () =>
      expect(await page.getByLabel('Username').inputValue()).toBe('fixture-owner'),
    );
    await press(live.socket, 'Tab');
    await send(live.socket, { type: 'text', text: browserCanary });
    await vi.waitFor(async () =>
      expect(await page.getByLabel('Password').inputValue()).toBe(browserCanary),
    );
    const early = await fixture.request('POST', `/api/browser/sessions/${id}/control`, {
      action: 'handback',
      version: control.session.version,
    });
    expect(early.statusCode).toBe(403);
    const framesBeforeLogin = live.frames;
    const statesBeforeLogin = live.states;
    await press(live.socket, 'Enter');
    await vi.waitFor(() => expect(page.url()).toBe('https://fixture.example/details'));
    expect(fixture.loginCanaryReceived).toBe(true);
    await vi.waitFor(
      () => {
        expect(live.states).toBeGreaterThan(statesBeforeLogin + 1);
        expect(live.frames).toBeGreaterThan(framesBeforeLogin);
        expect(live.socket.readyState).toBe(WebSocket.OPEN);
      },
      { timeout: 5000 },
    );
    live.socket.close();
    await vi.waitFor(() => expect(live.socket.readyState).toBe(WebSocket.CLOSED), {
      timeout: 5000,
    });
    await executor.execute(mission.run.id);
    expect(generations).toBe(2);
    const stillPaused = (await getMission(fixture.db, fixture.userId, mission.id))!;
    await expect(
      controlRun(fixture.db, fixture.userId, mission.run.id, {
        action: 'resume',
        version: stillPaused.mission.run.version,
        addCostUsd: 0,
        addSteps: 0,
        addWallTimeSeconds: 0,
      }),
    ).rejects.toMatchObject({ code: 'BROWSER_CONTROL_REQUIRED' });
    live = await viewer(id);
    const handback = await fixture.request('POST', `/api/browser/sessions/${id}/control`, {
      action: 'handback',
      version: control.session.version,
    });
    expect(handback.statusCode, handback.body).toBe(200);
    expect(handback.json<{ resumed: boolean }>().resumed).toBe(true);
    const before = fixture.submissions;
    const completed = await advance('completed');
    expect(fixture.detailsReceived).toBe(true);
    expect(fixture.submissions - before).toBe(1);
    expect(latest?.screenshot).toBe('withheld');
    expect(latest?.imageHandle).toBeUndefined();
    expect(completed.steps.some((step) => step.content.includes('fixture-42'))).toBe(true);
    expect(JSON.stringify(prompts)).not.toContain(browserCanary);
    expect(JSON.stringify(completed)).not.toContain(browserCanary);
    for (const table of [browserActions, runSteps, toolCalls, secrets, runs])
      expect(JSON.stringify(await fixture.db.orm.select().from(table))).not.toContain(
        browserCanary,
      );
    expect(fixture.logLines.join('')).not.toContain(browserCanary);
  });
  it('rejects unauthenticated, cross-origin and query-bearing upgrade requests before showing pixels', async () => {
    const run = await fixture.mission('Rejected views');
    const open = await run.act({ operation: 'open', args: { profileId: run.profile.id } });
    async function rejection(id: string, cookie: string, source: string) {
      const socket = connect(id, cookie, source);
      return new Promise<number>((resolve, reject) => {
        let denied = false;
        socket.on('error', () => {
          if (!denied) reject(new Error('The handshake failed before an HTTP denial.'));
        });
        socket.once('open', () => {
          socket.close();
          reject(new Error('An unauthorized browser view opened.'));
        });
        socket.once('unexpected-response', (_request, response) => {
          denied = true;
          response.resume();
          resolve(response.statusCode ?? 0);
          socket.terminate();
        });
      });
    }
    expect(await rejection(open.observation.sessionId, '', origin)).toBe(401);
    expect(
      await rejection(open.observation.sessionId, fixture.cookieHeader(), 'https://evil.example'),
    ).toBe(403);
    expect(
      await rejection(
        `${open.observation.sessionId}?token=forbidden`,
        fixture.cookieHeader(),
        origin,
      ),
    ).toBe(403);
    await fixture.client({ mode: 'close', sessionId: open.observation.sessionId });
  });
  it('fetches a completed screenshot only for the next claimed model generation and never stores pixels', async () => {
    const profile = await fixture.gateway.profiles.create(fixture.userId, {
      projectId: fixture.projectId,
      agentId: 'operator',
      name: 'Vision acceptance',
      site: 'https://fixture.example',
    });
    const mission = await createMission(
      fixture.db,
      fixture.userId,
      {
        projectId: fixture.projectId,
        agent: 'operator',
        goal: `Inspect the public page with profile ${profile.id}.`,
        requestId: randomUUID(),
      },
      { maxSteps: 20, maxCostUsd: 1, maxWallTimeSeconds: 600 },
    );
    let latest: BrowserObservation | undefined,
      generations = 0,
      imageCalls = 0;
    const images: string[] = [];
    const transport = workerBrowserTransport({
      config: { ...fixture.runtime.config, serverUrl },
      workerId: fixture.workerId,
      key: () => Promise.resolve(fixture.runtime.plumbing.operatorKey),
    });
    const tools = new ToolRegistry(
      createBrowserTools({
        request: async (...args) => {
          await recordHeartbeat(fixture.db, fixture.workerId);
          const result = await transport.request(...args);
          latest = result.observation;
          return result;
        },
      }),
    );
    const fetchImage = workerBrowserImage({
      config: { ...fixture.runtime.config, serverUrl },
      workerId: fixture.workerId,
      key: () => Promise.resolve(fixture.runtime.plumbing.operatorKey),
    });
    const executor = createDurableExecutor({
      database: fixture.db,
      workerId: fixture.workerId,
      dataDir: fixture.directory,
      getSettings: () => fixture.runtime.settings,
      tools,
      browserImage: async (scope, handle, signal) => {
        imageCalls++;
        await expect(
          fixture.gateway.image(
            browserImageRequestSchema.parse({
              ...handle,
              runId: scope.runId,
              claimKey: randomUUID(),
              workerId: fixture.workerId,
              nonce: randomUUID(),
              expiresAt: Date.now() + 45000,
            }),
          ),
        ).rejects.toMatchObject({ code: 'BROWSER_DENIED' });
        const image = await fetchImage(scope, handle, signal);
        expect(image?.data.slice(0, 3)).toBe('/9j');
        return image;
      },
      router: () => ({
        generate(request) {
          generations++;
          const incoming = request.messages.flatMap((message) =>
            message.role === 'user' ? (message.images ?? []) : [],
          );
          if (generations === 4) {
            expect(request.role).toBe('vision');
            expect(incoming).toHaveLength(1);
            images.push(incoming[0]!.data);
          } else expect(incoming).toEqual([]);
          const sessionId = latest?.sessionId;
          const next =
            generations === 1
              ? { name: 'browser.open', args: { profileId: profile.id } }
              : generations === 2
                ? { name: 'browser.navigate', args: { sessionId, url: 'https://fixture.example/' } }
                : generations === 3
                  ? { name: 'browser.screenshot', args: { sessionId } }
                  : generations === 4
                    ? { name: 'browser.read', args: { sessionId } }
                    : null;
          return Promise.resolve({
            text: next ? 'Inspect the public page.' : 'The public project page is visible.',
            toolCalls: next ? [{ id: `vision-${generations}`, ...next }] : [],
            finishReason: next ? ('tool-calls' as const) : ('stop' as const),
            providerId: 'fixture',
            modelId: 'fixture',
            costUsd: 0,
            costEstimated: false,
            latencyMs: 1,
            usage: {
              inputTokens: 10,
              outputTokens: 10,
              cachedInputTokens: 0,
              source: 'provider' as const,
            },
          });
        },
        generateObject: () => Promise.reject(new Error('This Operator does not plan.')),
      }),
    });
    for (let attempt = 0; attempt < 12; attempt++) {
      await executor.execute(mission.run.id);
      const detail = (await getMission(fixture.db, fixture.userId, mission.id))!;
      if (detail.mission.run.status === 'completed') break;
      const approval = detail.approvals.find((item) => item.status === 'pending');
      expect(approval, detail.mission.run.reason ?? detail.mission.run.status).toBeDefined();
      await decideApproval(
        fixture.db,
        fixture.userId,
        approval!.id,
        { action: 'approve', version: approval!.version, note: '' },
        tools,
        () => fixture.runtime.settings,
      );
    }
    expect((await getMission(fixture.db, fixture.userId, mission.id))?.mission.run.status).toBe(
      'completed',
    );
    expect(imageCalls).toBe(1);
    expect(generations).toBe(5);
    for (const table of [browserActions, runSteps, toolCalls, runs]) {
      const persisted = JSON.stringify(await fixture.db.orm.select().from(table));
      for (const pixels of images) expect(persisted).not.toContain(pixels);
    }
    const [run] = await fixture.db.orm.select().from(runs).where(eq(runs.id, mission.run.id));
    const saved = durableCheckpointSchema.parse(run!.checkpoint);
    expect(saved.browserImage).toBeUndefined();
    expect(
      checkpointSchema.safeParse({
        ...saved.loop,
        messages: [
          {
            role: 'user',
            content: 'forged',
            images: [{ mimeType: 'image/jpeg', data: images[0] }],
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('invalidates cached pixels after later browser actions or human takeover', async () => {
    const run = await fixture.mission('Image invalidation');
    const opened = await run.act({ operation: 'open', args: { profileId: run.profile.id } });
    const id = opened.observation.sessionId;
    const first = await run.act({ operation: 'screenshot', args: { sessionId: id } });
    expect(first.observation.imageHandle).toBeDefined();
    await run.act({
      operation: 'navigate',
      args: { sessionId: id, url: 'https://fixture.example/' },
    });
    await expect(
      fixture.client({ mode: 'image', sessionId: id, imageHandle: first.observation.imageHandle! }),
    ).rejects.toMatchObject({ code: 'BROWSER_DENIED' });
    const second = await run.act({ operation: 'screenshot', args: { sessionId: id } });
    await fixture.db.orm
      .update(runs)
      .set({ claimKey: null, status: 'paused' })
      .where(eq(runs.id, run.mission.run.id));
    const taken = await fixture.request('POST', `/api/browser/sessions/${id}/control`, {
      action: 'take',
      version: 1,
    });
    expect(taken.statusCode).toBe(200);
    await expect(
      fixture.client({
        mode: 'image',
        sessionId: id,
        imageHandle: second.observation.imageHandle!,
      }),
    ).rejects.toMatchObject({ code: 'BROWSER_DENIED' });
    await fixture.client({ mode: 'close', sessionId: id });
  });
  it('denies viewer input without human control and rejects stale control versions', async () => {
    const run = await fixture.mission('Read-only viewer');
    const opened = await run.act({ operation: 'open', args: { profileId: run.profile.id } });
    const id = opened.observation.sessionId;
    const live = await viewer(id);
    expect(live.inputAllowed).toBe(false);
    await send(live.socket, { type: 'text', text: 'Unapproved input' });
    await vi.waitFor(() => expect(live.socket.readyState).toBe(WebSocket.CLOSED), {
      timeout: 5000,
    });
    expect(fixture.service.engine.sessions.get(id)!.fields.size).toBe(0);
    expect(
      (
        await fixture.request('POST', `/api/browser/sessions/${id}/control`, {
          action: 'take',
          version: 99,
        })
      ).statusCode,
    ).toBe(409);
    await fixture.client({ mode: 'close', sessionId: id });
  });
  it.each(['expiry', 'profile revocation', 'cancellation'] as const)(
    'ends an existing live view after %s',
    async (reason) => {
      const run = await fixture.mission(`Live ${reason}`);
      const opened = await run.act({ operation: 'open', args: { profileId: run.profile.id } });
      const id = opened.observation.sessionId;
      const live = await viewer(id);
      if (reason === 'expiry')
        await fixture.db.orm
          .update(browserSessions)
          .set({ expiresAt: new Date(Date.now() - 1) })
          .where(eq(browserSessions.id, id));
      else if (reason === 'cancellation')
        await fixture.db.orm
          .update(runs)
          .set({ status: 'cancelled', claimKey: null })
          .where(eq(runs.id, run.mission.run.id));
      else
        await fixture.gateway.profiles.revoke(
          fixture.userId,
          run.profile.id,
          run.profile.version,
          true,
        );
      await vi.waitFor(() => expect(live.socket.readyState).toBe(WebSocket.CLOSED), {
        timeout: 5000,
      });
      expect(
        (
          await fixture.request('POST', `/api/browser/sessions/${id}/control`, {
            action: 'take',
            version: 1,
          })
        ).statusCode,
      ).toBe(403);
      await fixture.client({ mode: 'close', sessionId: id });
    },
  );
  it('disables human input during global pause and never resumes implicitly on disconnect', async () => {
    const run = await fixture.mission('Global pause');
    const opened = await run.act({ operation: 'open', args: { profileId: run.profile.id } });
    const id = opened.observation.sessionId;
    await fixture.db.orm
      .update(runs)
      .set({ claimKey: null, status: 'paused' })
      .where(eq(runs.id, run.mission.run.id));
    expect(
      (
        await fixture.request('POST', `/api/browser/sessions/${id}/control`, {
          action: 'take',
          version: 1,
        })
      ).statusCode,
    ).toBe(200);
    const live = await viewer(id);
    await vi.waitFor(() => expect(live.inputAllowed).toBe(true));
    await setControl(fixture.db, fixture.userId, true, (await getControl(fixture.db)).version);
    try {
      await vi.waitFor(() => expect(live.inputAllowed).toBe(false), { timeout: 3000 });
      await expect(
        fixture.service.engine.input(id, { type: 'text', text: 'Blocked' }),
      ).rejects.toMatchObject({ code: 'BROWSER_DENIED' });
      live.socket.close();
      const [row] = await fixture.db.orm
        .select()
        .from(browserSessions)
        .where(eq(browserSessions.id, id));
      expect(row?.control).toBe('human');
    } finally {
      await setControl(fixture.db, fixture.userId, false, (await getControl(fixture.db)).version);
      await fixture.client({ mode: 'close', sessionId: id });
    }
  });
  it('blocks queued human input between the handback snapshot and the versioned control commit', async () => {
    const run = await fixture.mission('Handback barrier');
    const opened = await run.act({ operation: 'open', args: { profileId: run.profile.id } });
    const id = opened.observation.sessionId;
    await fixture.db.orm
      .update(runs)
      .set({ status: 'paused', claimKey: null })
      .where(eq(runs.id, run.mission.run.id));
    expect(
      (
        await fixture.request('POST', `/api/browser/sessions/${id}/control`, {
          action: 'take',
          version: 1,
        })
      ).statusCode,
    ).toBe(200);
    expect((await fixture.client({ mode: 'handback', sessionId: id })).ready).toBe(true);
    await expect(
      fixture.service.engine.input(id, { type: 'text', text: 'late input' }),
    ).rejects.toMatchObject({ code: 'BROWSER_DENIED' });
    expect(
      (
        await fixture.request('POST', `/api/browser/sessions/${id}/control`, {
          action: 'handback',
          version: 2,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await fixture.request('POST', `/api/browser/sessions/${id}/control`, {
          action: 'take',
          version: 3,
        })
      ).statusCode,
    ).toBe(200);
    await fixture.service.engine.input(id, { type: 'text', text: 'new human control' });
    await fixture.client({ mode: 'close', sessionId: id });
  });
  it('reports actual Chromium readiness only behind authentication and closes live views on logout', async () => {
    expect(
      (await fixture.request('GET', '/api/browser/diagnostics', undefined, false)).statusCode,
    ).toBe(401);
    const response = await fixture.request('GET', '/api/browser/diagnostics');
    expect(response.statusCode).toBe(200);
    expect(response.json<{ browser: string; gpu: string }>()).toMatchObject({
      browser: 'ready',
      gpu: 'unknown',
    });
    const run = await fixture.mission('Logout');
    const opened = await run.act({ operation: 'open', args: { profileId: run.profile.id } });
    const live = await viewer(opened.observation.sessionId);
    expect((await fixture.request('POST', '/api/auth/sign-out', {})).statusCode).toBe(200);
    await vi.waitFor(() => expect(live.socket.readyState).toBe(WebSocket.CLOSED), {
      timeout: 5000,
    });
    await fixture.client({ mode: 'close', sessionId: opened.observation.sessionId });
  });
});
