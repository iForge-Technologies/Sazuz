import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureDatabasePassword, readInfraConfig, ConfigError } from '@sazuz/config';
import { createLogger, SazuzError } from '@sazuz/core';
import { createDatabase, migrateDatabase, type Database } from '@sazuz/db';
import { secretRedactor } from '@sazuz/vault';
import { developmentDatabaseEnvironment } from './dev-infrastructure.js';

const logger = createLogger('dev', secretRedactor);
let database: Database | undefined;
let child: ChildProcess | undefined;
let stopping = false;

function command(
  executable: string,
  args: string[],
  inherit = true,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn(executable, args, {
      stdio: inherit ? 'inherit' : 'ignore',
      windowsHide: true,
      env,
    });
    process.once('error', () => {
      reject(
        new SazuzError(
          'PREREQUISITE_MISSING',
          'Docker Engine and Compose are required when no database is already running. Install them using the official Docker instructions.',
        ),
      );
    });
    process.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new SazuzError('COMMAND_FAILED', 'Development infrastructure command failed.'));
    });
  });
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (child?.pid !== undefined && child.exitCode === null) {
    if (process.platform === 'win32') {
      try {
        await command('taskkill', ['/pid', String(child.pid), '/t', '/f'], false);
      } catch {
        logger.warn(
          { code: 'DEV_CHILD_ALREADY_EXITED' },
          'Development child processes already exited.',
        );
      }
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        logger.warn(
          { code: 'DEV_CHILD_ALREADY_EXITED' },
          'Development child processes already exited.',
        );
      }
    }
  }
  try {
    await database?.close();
  } catch {
    logger.error({ code: 'DB_CLOSE_FAILED' }, 'Development database pool could not close.');
    process.exitCode = 1;
  }
}

try {
  const config = readInfraConfig();
  if (config.databaseUrl === undefined) await ensureDatabasePassword(config.dataDir);
  database = await createDatabase(config, logger);
  try {
    await database.pool.query('SELECT 1');
  } catch {
    const environment = developmentDatabaseEnvironment(config);
    await command('docker', ['compose', 'version'], false);
    await command(
      'docker',
      [
        'compose',
        '-f',
        'deploy/compose.yaml',
        '-f',
        'deploy/compose.dev.yaml',
        'up',
        '-d',
        '--wait',
        'postgres',
      ],
      true,
      environment,
    );
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await database.pool.query('SELECT 1');
        ready = true;
        break;
      } catch {
        await delay(1_000);
      }
    }
    if (!ready) throw new SazuzError('DB_NOT_READY', 'PostgreSQL did not become ready in time.');
  }
  await migrateDatabase(database);
  await database.close();
  database = undefined;
  const packageManager = process.env.npm_execpath;
  if (packageManager === undefined)
    throw new SazuzError('PNPM_REQUIRED', 'Run development with pnpm dev.');
  const environment = {
    ...process.env,
    SAZUZ_DATA_DIR: config.dataDir,
    SAZUZ_SERVER_URL: config.serverUrl,
    NEXT_TELEMETRY_DISABLED: '1',
    TURBO_TELEMETRY_DISABLED: '1',
  };
  logger.info(
    { event: 'dev.starting', webPort: config.webPort },
    'Starting web, server, and worker.',
  );
  child = spawn(process.execPath, [packageManager, 'exec', 'turbo', 'run', 'dev', '--ui=stream'], {
    stdio: 'inherit',
    env: environment,
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
  child.once('error', () => {
    logger.error({ code: 'DEV_START_FAILED' }, 'Could not launch development services.');
    process.exitCode = 1;
    void stop();
  });
  child.once('exit', (code) => {
    if (!stopping) process.exitCode = code ?? 1;
    void stop();
  });
} catch (error: unknown) {
  logger.error(
    {
      code:
        error instanceof SazuzError || error instanceof ConfigError
          ? error.code
          : 'DEV_START_FAILED',
    },
    error instanceof SazuzError || error instanceof ConfigError
      ? error.message
      : 'Development services could not start.',
  );
  await stop();
  process.exitCode = 1;
}
