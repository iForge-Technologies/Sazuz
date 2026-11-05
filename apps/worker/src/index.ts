import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readInfraConfig } from '@sazuz/config';
import { freshSettings } from '@sazuz/config/settings';
import { createLogger, createWorkerId, SazuzError } from '@sazuz/core';
import {
  createDatabase,
  listenSettings,
  listenForRestore,
  recordHeartbeat,
  removeHeartbeat,
  workerSettings,
  type Database,
} from '@sazuz/db';
import { secretRedactor } from '@sazuz/vault';
import { startHeartbeat } from './heartbeat.js';
import { startWorkerServices } from '@sazuz/runtime';

const logger = createLogger('worker', secretRedactor);
const workerId = createWorkerId();
let database: Database | undefined;
let heartbeat: Awaited<ReturnType<typeof startHeartbeat>> | undefined;
let closing = false;
let settingsListener: Awaited<ReturnType<typeof listenSettings>> | undefined;
let services: Awaited<ReturnType<typeof startWorkerServices>> | undefined;
let restoreListener: Awaited<ReturnType<typeof listenForRestore>> | undefined;
let initialized = false,
  restartRequested = false;

function requestRestart() {
  restartRequested = true;
  if (initialized) void shutdown().then(() => process.exit(process.exitCode ?? 0));
}

async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  const cleanup = [
    ['RESTORE_LISTENER_CLOSE_FAILED', () => restoreListener?.close()],
    ['WORKER_SERVICES_CLOSE_FAILED', () => services?.close()],
    ['WORKER_SETTINGS_CLOSE_FAILED', () => settingsListener?.close()],
    ['WORKER_HEARTBEAT_CLOSE_FAILED', () => heartbeat?.stop()],
    ['DB_CLOSE_FAILED', () => database?.close()],
  ] as const;
  for (const [code, close] of cleanup) {
    try {
      await close();
    } catch {
      logger.error({ code }, 'A worker resource could not be closed.');
      process.exitCode = 1;
    }
  }
  logger.info({ event: 'worker.stopped', workerId }, 'Worker stopped.');
}

try {
  const config = readInfraConfig();
  // LISTEN, one mission lease, scheduler, Telegram and notification leadership each hold a connection.
  database = await createDatabase(config, logger, { maxConnections: 12 });
  restoreListener = await listenForRestore(database, requestRestart);
  let currentSettings = freshSettings();
  const connectedDatabase = database;
  heartbeat = await startHeartbeat({
    logger,
    write: () => recordHeartbeat(connectedDatabase, workerId),
    remove: () => removeHeartbeat(connectedDatabase, workerId),
  });
  settingsListener = await listenSettings(database, async (document) => {
    currentSettings = document;
    const versions = Object.fromEntries(
      Object.entries(document).map(([name, entry]) => [name, entry.version]),
    );
    await connectedDatabase.orm
      .insert(workerSettings)
      .values({ workerId, versions })
      .onConflictDoUpdate({
        target: workerSettings.workerId,
        set: { versions, appliedAt: new Date() },
      });
    logger.level = document.advanced.value.logLevel;
  });
  services = await startWorkerServices({
    database,
    config,
    workerId,
    getSettings: () => currentSettings,
  });
  await writeFile(join(tmpdir(), 'sazuz-worker-id'), workerId, { mode: 0o600 });
  initialized = true;
  if (restartRequested) {
    await shutdown();
    process.exit(process.exitCode ?? 0);
  }
  logger.info({ event: 'worker.ready', workerId, processId: process.pid }, 'Worker is ready.');
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
} catch (error: unknown) {
  logger.error(
    { code: error instanceof SazuzError ? error.code : 'WORKER_STARTUP_FAILED' },
    'Worker could not start.',
  );
  await shutdown();
  process.exitCode = 1;
}
