import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from './client.js';
import { listenForRestore } from './restore-listener.js';

function fixture() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn((_sql: string) => Promise.resolve(undefined)),
    release: vi.fn(),
  });
  const db = {
    coordination: { connect: vi.fn(() => Promise.resolve(client)) },
    logger: { warn: vi.fn() },
  } as unknown as Database;
  return { client, db, restart: vi.fn() };
}

describe('worker restore reload admission', () => {
  it('accepts only a restore identity and requests a single restart', async () => {
    const f = fixture();
    const listener = await listenForRestore(f.db, f.restart);
    f.client.emit('notification', { channel: 'instance_restored', payload: 'invalid' });
    f.client.emit('notification', { channel: 'other', payload: 'op_01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    expect(f.restart).not.toHaveBeenCalled();
    f.client.emit('notification', {
      channel: 'instance_restored',
      payload: 'op_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
    f.client.emit('end');
    expect(f.restart).toHaveBeenCalledTimes(1);
    await listener.close();
    await listener.close();
    expect(f.client.release).toHaveBeenCalledTimes(1);
  });
  it('fails closed when its connection loses restore notifications', async () => {
    const f = fixture();
    const listener = await listenForRestore(f.db, f.restart);
    f.client.emit('error', new Error('private database diagnostic'));
    expect(f.restart).toHaveBeenCalledTimes(1);
    f.client.query.mockRejectedValueOnce(new Error('private close diagnostic'));
    await listener.close();
    expect(f.client.release).toHaveBeenCalledWith(true);
    expect(JSON.stringify(vi.mocked(f.db.logger.warn).mock.calls)).not.toContain(
      'private close diagnostic',
    );
  });
  it('sanitizes startup failure and releases the failed connection', async () => {
    const f = fixture();
    f.client.query.mockRejectedValueOnce(new Error('private database diagnostic'));
    await expect(listenForRestore(f.db, f.restart)).rejects.toMatchObject({
      code: 'RESTORE_LISTENER_FAILED',
    });
    expect(f.client.release).toHaveBeenCalledWith(true);
    expect(f.client.listenerCount('notification')).toBe(0);
  });
});
