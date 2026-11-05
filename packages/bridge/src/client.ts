import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  bridgeCancelSchema,
  bridgeReadySchema,
  bridgeRequestSchema,
  BridgeError,
} from '@sazuz/core/bridge';
import { secretRedactor } from '@sazuz/vault';
import { manifest, localPin } from './local-config.js';
import { createLocalExecutor } from './local-execution.js';
import type { BridgeState } from './state.js';
import { bridgeSocketText } from './wire.js';

const incoming = z.discriminatedUnion('type', [
  bridgeReadySchema,
  bridgeRequestSchema,
  bridgeCancelSchema,
]);
/** This process opens only an outbound socket and never listens on a laptop port. */
export async function runBridge(
  state: BridgeState,
  signal: AbortSignal,
  status: (code: string) => void,
) {
  while (!signal.aborted) {
    try {
      await bridgeConnection(state, signal, status);
    } catch {
      if (!signal.aborted) status('BRIDGE_DISCONNECTED');
    }
    if (signal.aborted) break;
    try {
      await delay(2000, undefined, { signal });
    } catch {
      if (!signal.aborted) throw new BridgeError('BRIDGE_UNAVAILABLE');
    }
  }
}
export async function bridgeConnection(
  state: BridgeState,
  signal: AbortSignal,
  status: (code: string) => void,
) {
  const config = await state.configuration(),
    pin = localPin(config);
  return state.withPairing(
    (pairing) =>
      new Promise<void>((resolve, reject) => {
        secretRedactor.register(pairing.token);
        const socket = new WebSocket(pairing.endpoint, {
          headers: { authorization: `Bearer ${pairing.token}`, 'x-sazuz-device': pairing.deviceId },
          maxPayload: 16384,
          handshakeTimeout: 10000,
          followRedirects: false,
          perMessageDeflate: false,
        });
        const connection = new AbortController(),
          pending = new Map<string, AbortController>();
        const execute = createLocalExecutor(state);
        let ready = false,
          lastPing = Date.now(),
          working: Promise<void> | undefined;
        const close = () => {
          connection.abort();
          socket.terminate();
        };
        signal.addEventListener('abort', close, { once: true });
        const watch = setInterval(() => {
          if (Date.now() - lastPing > 25000) close();
        }, 5000);
        socket.on('ping', () => {
          lastPing = Date.now();
        });
        socket.once('open', () => {
          if (signal.aborted) {
            close();
            return;
          }
          socket.send(JSON.stringify({ type: 'hello', pin, manifest: manifest(config) }));
        });
        socket.on('message', (data, binary) => {
          try {
            if (binary) throw new BridgeError('BRIDGE_INVALID');
            const message = incoming.parse(JSON.parse(bridgeSocketText(data)) as unknown);
            if (message.type === 'ready') {
              if (
                ready ||
                message.deviceId !== pairing.deviceId ||
                message.projectId !== pairing.projectId ||
                message.pin !== pin
              )
                throw new BridgeError('BRIDGE_DENIED');
              ready = true;
              status('BRIDGE_CONNECTED');
              return;
            }
            if (!ready) throw new BridgeError('BRIDGE_DENIED');
            if (message.type === 'cancel') {
              pending.get(message.id)?.abort();
              return;
            }
            if (working || pending.has(message.id)) throw new BridgeError('BRIDGE_UNAVAILABLE');
            const controller = new AbortController();
            pending.set(message.id, controller);
            working = (async () => {
              let result;
              try {
                result = await execute(
                  message,
                  AbortSignal.any([signal, connection.signal, controller.signal]),
                );
              } catch (error) {
                status(error instanceof BridgeError ? error.code : 'BRIDGE_ACTION_FAILED');
                if (error instanceof BridgeError && error.code === 'BRIDGE_CHANGED') close();
                result = { status: 'unknown' as const };
              }
              if (socket.readyState === WebSocket.OPEN && !connection.signal.aborted)
                socket.send(JSON.stringify({ type: 'result', id: message.id, result }));
            })()
              .catch(() => {
                status('BRIDGE_ACTION_FAILED');
                close();
              })
              .finally(() => {
                pending.delete(message.id);
                working = undefined;
              });
          } catch {
            status('BRIDGE_PROTOCOL_DENIED');
            close();
          }
        });
        socket.once('error', () => {
          status('BRIDGE_DISCONNECTED');
          close();
        });
        socket.once('close', () => {
          clearInterval(watch);
          signal.removeEventListener('abort', close);
          connection.abort();
          void (working ?? Promise.resolve()).then(resolve, () =>
            reject(new BridgeError('BRIDGE_UNAVAILABLE')),
          );
        });
        if (signal.aborted) close();
      }),
  );
}
