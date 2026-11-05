import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { browserSocketText } from '@sazuz/browser/protocol';
import { startWebLiveGateway } from './web-live-gateway.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
describe('runtime live-browser gateway', () => {
  it('upgrades only the fixed path and carries owner cookies and origin in headers', async () => {
    const upstream = createServer();
    const websocket = new WebSocketServer({ server: upstream });
    const received: {
      cookie?: string;
      origin?: string;
      capability?: string | string[];
      authorization?: string;
      device?: string | string[];
    }[] = [];
    websocket.on('connection', (socket, request) => {
      received.push({
        ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
        ...(request.headers.origin ? { origin: request.headers.origin } : {}),
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(request.headers['x-sazuz-device'] ? { device: request.headers['x-sazuz-device'] } : {}),
        ...(request.headers['x-sazuz-capability']
          ? { capability: request.headers['x-sazuz-capability'] }
          : {}),
      });
      socket.on('message', (data) => socket.send(browserSocketText(data)));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => {
      for (const socket of websocket.clients) socket.terminate();
      await new Promise<void>((resolve) => websocket.close(() => upstream.close(() => resolve())));
    });
    const gateway = await startWebLiveGateway(
      { serverUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` },
      0,
    );
    cleanup.push(() => gateway.close());
    const url = `ws://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
    const path = '/live/browser/bsn_01K00000000000000000000000';
    const socket = new WebSocket(`${url}${path}`, {
      headers: {
        cookie: 'session=fixture',
        origin: 'https://sazuz.example',
        'x-sazuz-capability': 'must-not-forward',
      },
    });
    cleanup.push(() => {
      socket.terminate();
      return Promise.resolve();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const echoed = new Promise<string>((resolve) =>
      socket.once('message', (data) => resolve(browserSocketText(data))),
    );
    socket.send('frame transport');
    expect(await echoed).toBe('frame transport');
    expect(received).toEqual([{ cookie: 'session=fixture', origin: 'https://sazuz.example' }]);
    for (const denied of [
      `${path}?token=bad`,
      '/api/health',
      '/live/browser/invalid',
      '//evil.example/live',
      '/bridge?token=bad',
    ]) {
      const client = new WebSocket(`${url}${denied}`);
      const status = await new Promise<number>((resolve, reject) => {
        let rejected = false;
        client.once('unexpected-response', (_request, response) => {
          rejected = true;
          response.resume();
          resolve(response.statusCode ?? 0);
          client.terminate();
        });
        client.once('open', () => {
          client.terminate();
          reject(new Error('Invalid path was upgraded.'));
        });
        client.on('error', () => {
          if (!rejected) reject(new Error('Unexpected gateway error.'));
        });
      });
      expect(status).toBe(403);
    }
    expect(received).toHaveLength(1);
    const bridge = new WebSocket(`${url}/bridge`, {
      headers: {
        authorization: 'Bearer fixture-bridge-credential',
        'x-sazuz-device': 'fixture-device',
        cookie: 'must-not-forward',
      },
    });
    cleanup.push(() => {
      bridge.terminate();
      return Promise.resolve();
    });
    await new Promise<void>((resolve, reject) => {
      bridge.once('open', resolve);
      bridge.once('error', reject);
    });
    expect(received[1]).toEqual({
      authorization: 'Bearer fixture-bridge-credential',
      device: 'fixture-device',
    });
  });
});
