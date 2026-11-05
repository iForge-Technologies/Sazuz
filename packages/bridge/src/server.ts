import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  BridgeError,
  bridgeHelloSchema,
  bridgeRequestSchema,
  bridgeResponseSchema,
  type BridgeRequest,
} from '@sazuz/core/bridge';
import type { ExternalResult } from '@sazuz/core/mcp';
import { bridgeDevices, type Database } from '@sazuz/db';
import { offerBridge } from './store.js';
import { bridgeSocketText } from './wire.js';

type Authenticate = () => Promise<typeof bridgeDevices.$inferSelect>;
interface Peer {
  socket: WebSocket;
  id: string;
  connectionId: string;
  pin: string;
  authenticate: Authenticate;
  pending?: { id: string; finish: (result: ExternalResult) => void };
}
export function createBridgeHub(db: Database) {
  const peers = new Map<string, Peer>(),
    sockets = new Set<WebSocket>();
  const incoming = z.discriminatedUnion('type', [bridgeHelloSchema, bridgeResponseSchema]);
  function attach(socket: WebSocket, authenticate: Authenticate) {
    sockets.add(socket);
    let peer: Peer | undefined,
      handshaking = false,
      checking = false,
      lastPong = Date.now();
    const expiry = setTimeout(() => socket.terminate(), 10000);
    const watch = setInterval(() => {
      if (checking || !peer) return;
      checking = true;
      void (async () => {
        const device = await authenticate();
        if (Date.now() - lastPong > 15000 || device.connectionId !== peer.connectionId)
          throw new BridgeError('BRIDGE_DENIED');
        socket.ping();
        await db.orm
          .update(bridgeDevices)
          .set({ lastSeenAt: new Date() })
          .where(
            and(eq(bridgeDevices.id, peer.id), eq(bridgeDevices.connectionId, peer.connectionId)),
          );
      })()
        .catch(() => {
          socket.terminate();
        })
        .finally(() => {
          checking = false;
        });
    }, 5000);
    socket.on('pong', () => {
      lastPong = Date.now();
    });
    socket.on('message', (data, binary) => {
      void (async () => {
        if (binary) throw new BridgeError('BRIDGE_INVALID');
        const message = incoming.parse(JSON.parse(bridgeSocketText(data)) as unknown);
        if (message.type === 'hello') {
          if (peer || handshaking) throw new BridgeError('BRIDGE_DENIED');
          handshaking = true;
          const device = await authenticate(),
            connectionId = randomUUID();
          if (peers.has(device.id)) throw new BridgeError('BRIDGE_UNAVAILABLE');
          await offerBridge(db, device.id, connectionId, message);
          peer = { socket, id: device.id, connectionId, pin: message.pin, authenticate };
          if (socket.readyState !== WebSocket.OPEN) {
            await db.orm
              .update(bridgeDevices)
              .set({ connectionId: null })
              .where(
                and(eq(bridgeDevices.id, device.id), eq(bridgeDevices.connectionId, connectionId)),
              );
            return;
          }
          peers.set(device.id, peer);
          clearTimeout(expiry);
          socket.send(
            JSON.stringify({
              type: 'ready',
              deviceId: device.id,
              projectId: device.projectId,
              pin: message.pin,
            }),
          );
        } else {
          if (!peer) throw new BridgeError('BRIDGE_DENIED');
          if (peer.pending?.id === message.id) peer.pending.finish(message.result);
        }
      })().catch(() => {
        db.logger.warn({ code: 'BRIDGE_PROTOCOL_DENIED' }, 'Bridge connection refused.');
        socket.terminate();
      });
    });
    socket.on('error', () => socket.terminate());
    socket.once('close', () => {
      clearTimeout(expiry);
      clearInterval(watch);
      sockets.delete(socket);
      if (peer) {
        if (peers.get(peer.id) === peer) peers.delete(peer.id);
        peer.pending?.finish({ status: 'unknown' });
        void db.orm
          .update(bridgeDevices)
          .set({ connectionId: null })
          .where(
            and(eq(bridgeDevices.id, peer.id), eq(bridgeDevices.connectionId, peer.connectionId)),
          )
          .catch(() =>
            db.logger.warn(
              { code: 'BRIDGE_DISCONNECT_RECORD_FAILED' },
              'Bridge status will expire.',
            ),
          );
      }
    });
  }
  async function dispatch(input: BridgeRequest, signal: AbortSignal): Promise<ExternalResult> {
    const request = bridgeRequestSchema.parse(input),
      peer = peers.get(request.deviceId);
    if (!peer || peer.pending || peer.socket.readyState !== WebSocket.OPEN)
      throw new BridgeError('BRIDGE_UNAVAILABLE');
    const device = await peer.authenticate();
    if (peer.pending) throw new BridgeError('BRIDGE_UNAVAILABLE');
    if (
      device.version !== request.version ||
      device.projectId !== request.projectId ||
      peer.pin !== request.pin ||
      device.offeredPin !== request.pin ||
      device.connectionId !== peer.connectionId ||
      signal.aborted ||
      request.deadline <= Date.now()
    )
      throw new BridgeError('BRIDGE_DENIED');
    return new Promise((resolve) => {
      const finish = (result: ExternalResult) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        if (peer.pending?.id === request.id) delete peer.pending;
        resolve(result);
      };
      const cancel = () => {
        if (peer.socket.readyState === WebSocket.OPEN)
          peer.socket.send(JSON.stringify({ type: 'cancel', id: request.id }));
        finish({ status: 'unknown' });
      };
      const timeout = setTimeout(
        cancel,
        Math.max(1, Math.min(40000, request.deadline - Date.now())),
      );
      peer.pending = { id: request.id, finish };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) {
        cancel();
        return;
      }
      peer.socket.send(JSON.stringify(request), (error) => {
        if (error) finish({ status: 'unknown' });
      });
    });
  }
  return {
    attach,
    dispatch,
    revoke(id: string) {
      peers.get(id)?.socket.terminate();
    },
    close() {
      for (const socket of sockets) socket.terminate();
    },
  };
}
export type BridgeHub = ReturnType<typeof createBridgeHub>;
