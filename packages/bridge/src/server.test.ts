import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import type { Database, bridgeDevices } from '@sazuz/db';
import { bridgeCancelSchema, bridgeRequestSchema, bridgeReadySchema } from '@sazuz/core/bridge';
import { createBridgeHub } from './server.js';
import { offerBridge } from './store.js';
import { bridgeSocketText } from './wire.js';

vi.mock('./store.js', () => ({ offerBridge: vi.fn() }));

it('refuses a concurrent dispatch after asynchronous authentication without interrupting the admitted call', async () => {
  const device: typeof bridgeDevices.$inferSelect = {
    id: 'brg_01K00000000000000000000000',
    userId: 'usr_01K00000000000000000000000',
    projectId: 'prj_01K00000000000000000000000',
    name: 'Concurrent dispatch fixture',
    secretRef: 'secret://sec_01K00000000000000000000000',
    tokenHash: 'a'.repeat(64),
    version: 1,
    enabled: true,
    offeredPin: 'b'.repeat(64),
    offered: null,
    connectionId: null,
    lastSeenAt: null,
    createdAt: new Date(),
  };
  // Storage behavior is covered by PostgreSQL tests; this fixture exercises the real socket hub.
  const db = {
    orm: { update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) },
    logger: { warn: vi.fn() },
  } as unknown as Database;
  vi.mocked(offerBridge).mockImplementation((_db, _id, connectionId) => {
    device.connectionId = connectionId;
    return Promise.resolve(device);
  });
  const authenticate = vi.fn(() => Promise.resolve(device)),
    hub = createBridgeHub(db),
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket) => hub.attach(socket, authenticate));
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture socket address.');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`),
    firstController = new AbortController(),
    secondController = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const requests: ReturnType<typeof bridgeRequestSchema.parse>[] = [];
  try {
    await once(socket, 'open');
    const ready = once(socket, 'message');
    socket.send(
      JSON.stringify({
        type: 'hello',
        pin: device.offeredPin,
        manifest: { folders: [], commands: [], notifications: false, privateOnly: true },
      }),
    );
    const [message] = (await ready) as [WebSocket.RawData];
    bridgeReadySchema.parse(JSON.parse(bridgeSocketText(message)));
    socket.on('message', (data) => {
      const value: unknown = JSON.parse(bridgeSocketText(data)),
        request = bridgeRequestSchema.safeParse(value);
      if (request.success) requests.push(request.data);
      else bridgeCancelSchema.parse(value);
    });
    let releaseAuthentication!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAuthentication = resolve;
    });
    authenticate.mockImplementationOnce(async () => {
      await gate;
      return device;
    });
    authenticate.mockImplementationOnce(async () => {
      await gate;
      return device;
    });
    const request = () =>
      bridgeRequestSchema.parse({
        type: 'request',
        id: randomUUID(),
        deviceId: device.id,
        projectId: device.projectId,
        agentId: 'operator',
        key: randomUUID(),
        pin: device.offeredPin,
        version: device.version,
        tool: 'local.fs.read',
        args: { deviceId: device.id, folder: 'notes', path: 'marker.txt' },
        deadline: Date.now() + 10000,
        verify: false,
      });
    const firstRequest = request(),
      secondRequest = request(),
      first = hub.dispatch(firstRequest, firstController.signal),
      second = hub.dispatch(secondRequest, secondController.signal);
    // A broken hub resolves the second call as uncertain on timeout instead of refusing admission.
    deadline = setTimeout(() => secondController.abort(), 1000);
    const refused = expect(second).rejects.toMatchObject({ code: 'BRIDGE_UNAVAILABLE' });
    releaseAuthentication();
    await refused;
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.id).toBe(firstRequest.id);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.send(
      JSON.stringify({
        type: 'result',
        id: firstRequest.id,
        result: { status: 'done', output: { content: 'scoped marker' } },
      }),
    );
    await expect(first).resolves.toEqual({ status: 'done', output: { content: 'scoped marker' } });
  } finally {
    if (deadline) clearTimeout(deadline);
    firstController.abort();
    secondController.abort();
    socket.terminate();
    hub.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
