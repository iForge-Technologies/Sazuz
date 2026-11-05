import { BridgeError, bridgeDeviceInputSchema, bridgeSaveSchema } from '@sazuz/core/bridge';
import { integrationControlSchema } from '@sazuz/core/mcp';
import {
  authenticateBridge,
  bridgeHistory,
  controlBridgeDevice,
  createBridgeDevice,
  createBridgeHub,
  getBridgeDevice,
  listBridgeDevices,
  saveBridgeGrant,
} from '@sazuz/bridge';
import type { McpSecretResolver } from '@sazuz/mcp';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { emptyRequest, parseRequest, workPath } from './phase-three-shared.js';

export function registerBridge(app: Awaited<ReturnType<typeof createApp>>, runtime: PhaseOne) {
  const db = runtime.database,
    hub = createBridgeHub(db);
  const resolve: McpSecretResolver = (reference, consume) =>
    runtime.vault.withSecret(reference, 'user', consume);
  app.get('/api/bridge/devices', async (request) => {
    const { user } = await runtime.admin(request);
    parseRequest(emptyRequest, request.query);
    return listBridgeDevices(db, user.id);
  });
  app.post('/api/bridge/devices', async (request) => {
    const { user } = await runtime.admin(request);
    await runtime.rateLimit(`bridge-create:${user.id}`, 10);
    return createBridgeDevice(
      db,
      user.id,
      parseRequest(bridgeDeviceInputSchema, request.body),
      resolve,
    );
  });
  app.get('/api/bridge/devices/:id', async (request) => {
    const { user } = await runtime.admin(request),
      { id } = parseRequest(workPath, request.params);
    parseRequest(emptyRequest, request.query);
    return getBridgeDevice(db, user.id, id);
  });
  app.put('/api/bridge/devices/:id', async (request) => {
    const { user } = await runtime.admin(request),
      { id } = parseRequest(workPath, request.params);
    const result = await saveBridgeGrant(
      db,
      user.id,
      id,
      parseRequest(bridgeSaveSchema, request.body),
    );
    hub.revoke(id);
    return result;
  });
  app.get('/api/bridge/devices/:id/history', async (request) => {
    const { user } = await runtime.admin(request),
      { id } = parseRequest(workPath, request.params);
    parseRequest(emptyRequest, request.query);
    return bridgeHistory(db, user.id, id);
  });
  app.post('/api/bridge/devices/:id/control', async (request) => {
    const { user } = await runtime.admin(request),
      { id } = parseRequest(workPath, request.params);
    const input = parseRequest(integrationControlSchema, request.body);
    const result = await controlBridgeDevice(db, user.id, id, input);
    if (!input.enabled) hub.revoke(id);
    return result;
  });
  app.get(
    '/bridge',
    {
      websocket: true,
      preValidation: async (request) => {
        parseRequest(emptyRequest, request.query);
        if (request.headers.origin) throw new BridgeError('BRIDGE_DENIED');
        const device = await authenticateBridge(
          db,
          request.headers['x-sazuz-device'],
          request.headers.authorization,
          resolve,
        );
        await runtime.rateLimit(`bridge-connect:${device.id}`, 40);
        request.raw.socket?.setTimeout?.(0);
      },
    },
    (socket, request) => {
      hub.attach(socket, () =>
        authenticateBridge(
          db,
          request.headers['x-sazuz-device'],
          request.headers.authorization,
          resolve,
        ),
      );
    },
  );
  app.addHook('onClose', () => {
    hub.close();
    return Promise.resolve();
  });
  return hub;
}
