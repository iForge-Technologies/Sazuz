import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@sazuz/core';
import { SecretRedactor } from '@sazuz/vault';
import { startHeartbeat } from './heartbeat.js';

const logger = createLogger('worker-test', new SecretRedactor(), { write: () => undefined });
afterEach(() => {
  vi.useRealTimers();
});

describe('worker heartbeat lifecycle', () => {
  it('writes immediately, retries failures, and removes its heartbeat once at shutdown', async () => {
    vi.useFakeTimers();
    const write = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const remove = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const heartbeat = await startHeartbeat({ write, remove, logger, intervalMs: 100 });
    expect(write).toHaveBeenCalledTimes(1);
    write.mockRejectedValueOnce(new Error('database offline'));
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(write).toHaveBeenCalledTimes(3);
    await heartbeat.stop();
    await heartbeat.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('waits for a slow write before scheduling or removing a heartbeat', async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const write = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    const remove = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const heartbeat = await startHeartbeat({ write, remove, logger, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).toHaveBeenCalledTimes(2);
    const stopped = heartbeat.stop();
    expect(remove).not.toHaveBeenCalled();
    finish?.();
    await stopped;
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does not start when the initial database write fails', async () => {
    const write = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('offline'));
    await expect(
      startHeartbeat({ write, remove: () => Promise.resolve(), logger }),
    ).rejects.toThrow('offline');
  });
});
