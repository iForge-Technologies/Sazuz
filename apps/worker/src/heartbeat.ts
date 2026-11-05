import { HEARTBEAT_INTERVAL_MS, type createLogger } from '@sazuz/core';

export interface HeartbeatOptions {
  write(): Promise<void>;
  remove(): Promise<void>;
  logger: ReturnType<typeof createLogger>;
  intervalMs?: number;
}

/** Serial writes ensure a slow database cannot create an overlapping timer backlog. */
export async function startHeartbeat(
  options: HeartbeatOptions,
): Promise<{ stop(): Promise<void> }> {
  await options.write();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let inFlight: Promise<void> | undefined;
  const schedule = (): void => {
    timer = setTimeout(() => {
      inFlight = tick();
    }, options.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  };
  const tick = async (): Promise<void> => {
    try {
      await options.write();
    } catch {
      options.logger.error(
        { code: 'HEARTBEAT_FAILED' },
        'Worker heartbeat failed; retrying on the next interval.',
      );
    } finally {
      if (!stopped) schedule();
    }
  };
  schedule();
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      await inFlight;
      await options.remove();
    },
  };
}
