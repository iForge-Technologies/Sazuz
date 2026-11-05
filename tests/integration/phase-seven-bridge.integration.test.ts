import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { bridgeDeviceSchema, type BridgeTool } from '@sazuz/core/bridge';
import {
  bridgeCalls,
  bridgeDevices,
  createMission,
  getMission,
  runs,
  workerHeartbeats,
  workKey,
} from '@sazuz/db';
import { BridgeState } from '../../packages/bridge/src/state.js';
import { bridgeTools, selectedBridge } from '../../packages/bridge/src/index.js';
import { ToolRegistry } from '../../packages/tools/src/index.js';
import { workerExternalDispatch } from '../../packages/mcp/src/index.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { ensureAgents, getAgent, saveAgent } from '../../packages/orchestrator/src/index.js';
import { registerPhaseSeven } from '../../apps/server/src/phase-seven.js';
import { phaseFourFixture } from './phase-four-fixture.js';
import { createFixtureRouter } from './phase-three-runtime-worker.js';

describe('Phase 7 Bridge through the actual outbound CLI and durable worker gateway', () => {
  let fixture: Awaited<ReturnType<typeof phaseFourFixture>>,
    directory: string,
    root: string,
    state: BridgeState;
  let device: ReturnType<typeof bridgeDeviceSchema.parse>,
    address: string,
    child: ChildProcess | undefined;
  const output: string[] = [],
    token = 'phase7-device-token-canary-90871235640',
    workerId = workKey('wrk');
  async function stopCli() {
    const process = child;
    child = undefined;
    if (!process || process.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      process.once('close', () => resolve());
      process.kill();
    });
    await vi.waitFor(async () => {
      const [row] = await fixture.db.orm
        .select()
        .from(bridgeDevices)
        .where(eq(bridgeDevices.id, device.id));
      expect(row!.connectionId).toBeNull();
    });
  }
  async function online(previous?: string | null) {
    await vi.waitFor(
      async () => {
        const [row] = await fixture.db.orm
          .select()
          .from(bridgeDevices)
          .where(eq(bridgeDevices.id, device.id));
        expect(row!.connectionId).toBeTruthy();
        if (previous) expect(row!.connectionId).not.toBe(previous);
        device = bridgeDeviceSchema.parse(
          (await fixture.request('GET', `/api/bridge/devices/${device.id}`)).json(),
        );
        expect(device.online).toBe(true);
        expect(device.offeredPin).toBeTruthy();
      },
      { timeout: 15000, interval: 100 },
    );
  }
  async function startCli() {
    child = spawn(
      process.execPath,
      ['--import', 'tsx', 'apps/bridge/src/main.ts', 'run', '--state', join(directory, 'state')],
      {
        cwd: resolve('.'),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (data: Buffer) => {
        if (output.length < 200) output.push(data.toString('utf8'));
      });
    await online();
  }
  beforeAll(async () => {
    fixture = await phaseFourFixture((app, runtime) => {
      registerPhaseSeven(app, runtime);
    });
    await ensureAgents(fixture.db, fixture.userId);
    const operator = await getAgent(fixture.db, fixture.userId, 'operator');
    await saveAgent(
      fixture.db,
      fixture.userId,
      'operator',
      {
        expectedVersion: operator.version,
        definition: { ...operator.definition, tools: [...operator.definition.tools, 'local.*'] },
      },
      [],
    );
    const secret = await fixture.runtime.vault.create({
      name: 'Bridge test credential',
      value: token,
      createdBy: fixture.userId,
    });
    const response = await fixture.request('POST', '/api/bridge/devices', {
      name: 'Fixture laptop',
      projectId: fixture.projectId,
      secretRef: secret.reference,
    });
    expect(response.statusCode, response.body).toBe(200);
    device = bridgeDeviceSchema.parse(response.json());
    expect(device.grant).toBeNull();
    expect(response.body).not.toContain(token);
    address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    directory = await mkdtemp(join(tmpdir(), 'sazuz-phase7-bridge-'));
    root = join(directory, 'scope');
    await mkdir(root);
    await writeFile(join(root, 'marker.txt'), 'bridge-authorized-marker');
    await writeFile(join(directory, 'outside.txt'), 'bridge-outside-denied-marker');
    await writeFile(
      join(root, 'effect.cjs'),
      "const fs=require('node:fs'); const file='counter.txt'; fs.writeFileSync(file,String(Number(fs.existsSync(file)?fs.readFileSync(file,'utf8'):0)+1)); setTimeout(()=>console.log('finished'),3000);",
    );
    state = await BridgeState.create(
      join(directory, 'state'),
      'bridge-integration-passphrase-38721',
      {
        endpoint: address.replace('http:', 'ws:') + '/bridge',
        deviceId: device.id,
        projectId: fixture.projectId,
        token,
      },
      {
        folders: [{ alias: 'notes', root, mode: 'write', delete: true }],
        commands: [
          {
            alias: 'effect',
            executable: process.execPath,
            args: [join(root, 'effect.cjs')],
            folder: 'notes',
          },
        ],
        privateOnly: false,
      },
    );
    await fixture.db.orm.insert(workerHeartbeats).values({ id: workerId });
    await startCli();
  }, 120000);
  afterAll(async () => {
    await stopCli();
    state?.close();
    await fixture?.close();
    if (
      directory &&
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
      directory.includes('sazuz-phase7-bridge-')
    )
      await rm(directory, { recursive: true, force: true });
  });
  async function mission(tool: BridgeTool, args: Record<string, unknown>) {
    await fixture.db.orm
      .update(workerHeartbeats)
      .set({ lastSeenAt: new Date() })
      .where(eq(workerHeartbeats.id, workerId));
    const created = await createMission(
      fixture.db,
      fixture.userId,
      {
        projectId: fixture.projectId,
        agent: 'operator',
        requestId: randomUUID(),
        goal: 'Exercise the explicitly scoped laptop fixture.',
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
        const tools = bridgeTools(await selectedBridge(fixture.db, runId, true), agentId, dispatch);
        return { tools, tainted: tools.length > 0 };
      },
      router: () => createFixtureRouter({ toolName: tool, args: { deviceId: device.id, ...args } }),
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
  it('offers scopes without automatic grants, rejects expansion, and saves a versioned owner-reviewed grant', async () => {
    expect(device.offered?.folders[0]!.alias).toBe('notes');
    expect((await fixture.request('GET', '/api/bridge/devices', undefined, false)).statusCode).toBe(
      401,
    );
    const invalid = await fixture.request('PUT', `/api/bridge/devices/${device.id}`, {
      expectedVersion: device.version,
      grant: {
        ...device.offered,
        pin: device.offeredPin,
        agents: ['operator'],
        tools: ['local.fs.read'],
        folders: [{ alias: 'outside', mode: 'write', delete: true }],
      },
    });
    expect(invalid.statusCode).toBe(403);
    const [prior] = await fixture.db.orm
      .select()
      .from(bridgeDevices)
      .where(eq(bridgeDevices.id, device.id));
    const response = await fixture.request('PUT', `/api/bridge/devices/${device.id}`, {
      expectedVersion: device.version,
      grant: {
        ...device.offered,
        pin: device.offeredPin,
        agents: ['operator'],
        tools: ['local.fs.read', 'local.fs.write', 'local.exec'],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    device = bridgeDeviceSchema.parse(response.json());
    expect(device.version).toBe(2);
    await online(prior!.connectionId);
    const history = await fixture.request('GET', `/api/bridge/devices/${device.id}/history`);
    expect(history.body).toContain('operator');
    expect(history.body).not.toContain(token);
    expect(history.body).not.toContain(root);
  });
  it('reads the scoped marker through a real CLI and refuses an outside path before dispatch', async () => {
    const allowed = await mission('local.fs.read', { folder: 'notes', path: 'marker.txt' });
    const detail = (await allowed.detail())!;
    expect(detail.mission.run.status, JSON.stringify(detail)).toBe('completed');
    expect(detail.mission.run.tainted).toBe(true);
    expect(JSON.stringify(detail)).toContain('bridge-authorized-marker');
    expect(JSON.stringify(detail)).toContain('<untrusted>');
    const outside = await mission('local.fs.read', { folder: 'notes', path: '../outside.txt' });
    expect(JSON.stringify(await outside.detail())).not.toContain('bridge-outside-denied-marker');
    expect(
      await fixture.db.orm
        .select()
        .from(bridgeCalls)
        .where(eq(bridgeCalls.runId, outside.created.run.id)),
    ).toHaveLength(0);
  });
  it('asks before a write, persists completion and replays without another side effect', async () => {
    const run = await mission('local.fs.write', {
      folder: 'notes',
      path: 'written.txt',
      content: 'approved local content',
    });
    expect((await run.detail())!.mission.run.status).toBe('waiting_approval');
    await expect(readFile(join(root, 'written.txt'))).rejects.toThrow();
    await approve(run);
    await run.executor.execute(run.created.run.id);
    expect((await run.detail())!.mission.run.status).toBe('completed');
    expect(await readFile(join(root, 'written.txt'), 'utf8')).toBe('approved local content');
    await run.executor.execute(run.created.run.id);
    const receipts = await fixture.db.orm
      .select()
      .from(bridgeCalls)
      .where(eq(bridgeCalls.runId, run.created.run.id));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.status).toBe('done');
  });
  it('survives companion process loss without repeating an uncertain fixed command', async () => {
    const run = await mission('local.exec', { command: 'effect' });
    expect((await run.detail())!.mission.run.status).toBe('waiting_approval');
    await approve(run);
    const running = run.executor.execute(run.created.run.id);
    await vi.waitFor(
      async () => {
        expect(await readFile(join(root, 'counter.txt'), 'utf8')).toBe('1');
      },
      { timeout: 15000, interval: 50 },
    );
    await stopCli();
    await running;
    expect((await run.detail())!.mission.run.status).toBe('waiting_approval');
    await startCli();
    await fixture.db.orm
      .update(runs)
      .set({ status: 'queued' })
      .where(eq(runs.id, run.created.run.id));
    await run.executor.execute(run.created.run.id);
    expect(
      (await run.detail())!.approvals.some(
        (approval) => approval.kind === 'uncertain' && approval.status === 'pending',
      ),
    ).toBe(true);
    expect(await readFile(join(root, 'counter.txt'), 'utf8')).toBe('1');
  }, 60000);
  it('offers a changed local pin without redirecting an existing approval to a new root', async () => {
    const pending = await mission('local.fs.write', {
      folder: 'notes',
      path: 'changed-pin.txt',
      content: 'must not follow changed authority',
    });
    const approval = (await pending.detail())!.approvals[0]!;
    const oldRoot = root,
      oldPin = device.offeredPin;
    await stopCli();
    root = join(directory, 'replacement');
    await mkdir(root);
    await writeFile(join(root, 'marker.txt'), 'reviewed-replacement-marker');
    await state.configure({
      folders: [{ alias: 'notes', root, mode: 'write', delete: true }],
      commands: [],
      privateOnly: false,
    });
    await startCli();
    expect(device.offeredPin).not.toBe(oldPin);
    expect(device.grant!.pin).toBe(oldPin);
    const denied = () =>
      fixture.request('POST', `/api/approvals/${approval.id}/decision`, {
        version: approval.version,
        action: 'approve',
      });
    expect((await denied()).statusCode).toBe(400);
    const [prior] = await fixture.db.orm
      .select()
      .from(bridgeDevices)
      .where(eq(bridgeDevices.id, device.id));
    const response = await fixture.request('PUT', `/api/bridge/devices/${device.id}`, {
      expectedVersion: device.version,
      grant: {
        ...device.offered,
        pin: device.offeredPin,
        agents: ['operator'],
        tools: ['local.fs.read', 'local.fs.write'],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    device = bridgeDeviceSchema.parse(response.json());
    await online(prior!.connectionId);
    expect((await denied()).statusCode).toBe(400);
    for (const folder of [oldRoot, root])
      await expect(readFile(join(folder, 'changed-pin.txt'))).rejects.toThrow();
    const fresh = await mission('local.fs.read', { folder: 'notes', path: 'marker.txt' });
    expect((await fresh.detail())!.mission.run.status).toBe('completed');
    expect(JSON.stringify(await fresh.detail())).toContain('reviewed-replacement-marker');
  }, 60000);
  it('revokes a pending grant before approval and keeps device credentials out of APIs and logs', async () => {
    const run = await mission('local.fs.write', {
      folder: 'notes',
      path: 'revoked.txt',
      content: 'must remain absent',
    });
    const approval = (await run.detail())!.approvals[0]!;
    const response = await fixture.request('POST', `/api/bridge/devices/${device.id}/control`, {
      expectedVersion: device.version,
      enabled: false,
    });
    expect(response.statusCode).toBe(200);
    expect(
      (
        await fixture.request('POST', `/api/approvals/${approval.id}/decision`, {
          version: approval.version,
          action: 'approve',
        })
      ).statusCode,
    ).toBe(400);
    await expect(readFile(join(root, 'revoked.txt'))).rejects.toThrow();
    const publicDevices = await fixture.request('GET', '/api/bridge/devices');
    expect(
      JSON.stringify({ api: publicDevices.body, logs: fixture.logLines, companion: output }),
    ).not.toContain(token);
    expect(publicDevices.body).not.toContain(root);
  });
});
