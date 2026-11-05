import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { readInfraConfig } from '@sazuz/config';
import { healthSchema } from '@sazuz/core/health';
import { z } from 'zod';

const packageManager = z.string().min(1).parse(process.env.npm_execpath);
const config = readInfraConfig();
const baseUrl = `http://127.0.0.1:${config.webPort}`;
const environment = {
  ...process.env,
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  NEXT_TELEMETRY_DISABLED: '1',
  TURBO_TELEMETRY_DISABLED: '1',
  SAZUZ_DATA_DIR: config.dataDir,
};
const children: ChildProcess[] = [];
const output: string[] = [];
let workerPid: number | undefined;

async function requireFreePort(port: number): Promise<void> {
  const server = createServer();
  server.listen(port, '127.0.0.1');
  try {
    await once(server, 'listening');
  } catch {
    throw new Error('A smoke-test application port is already in use. Stop that instance first.');
  }
  await new Promise<void>((done) =>
    server.close(() => {
      done();
    }),
  );
}

function capture(child: ChildProcess): void {
  children.push(child);
  let partial = '';
  const collect = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    output.push(text);
    partial += text;
    const lines = partial.split(/\r?\n/);
    partial = lines.pop() ?? '';
    for (const line of lines) {
      const start = line.indexOf('{');
      if (start < 0 || !line.includes('"event":"worker.ready"')) continue;
      const parsed: unknown = JSON.parse(line.slice(start));
      const event = z
        .object({ event: z.literal('worker.ready'), processId: z.number().int().positive() })
        .safeParse(parsed);
      if (event.success) workerPid = event.data.processId;
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
}

async function waitForHealth(status: 'ok' | 'degraded', timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(3_000) });
      const health = healthSchema.parse(await response.json());
      if (health.status === status && response.status === (status === 'ok' ? 200 : 503))
        return health;
    } catch {
      // Startup and compilation may temporarily refuse requests; the deadline is enforced below.
    }
    await delay(500);
  }
  throw new Error(`Development health did not become ${status} before the deadline.`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await once(killer, 'exit');
  } else {
    process.kill(-child.pid, 'SIGTERM');
    await Promise.race([once(child, 'exit'), delay(5_000)]);
    if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL');
  }
}

try {
  await requireFreePort(config.webPort);
  await requireFreePort(config.serverPort);
  const dev = spawn(process.execPath, [packageManager, 'dev'], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'pipe',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  capture(dev);
  const healthy = await waitForHealth('ok');
  assert.equal(healthy.services.database.status, 'ok');
  assert.ok(healthy.services.worker.activeCount >= 1);
  assert.ok(workerPid !== undefined, 'The actual worker process must announce readiness.');
  process.stdout.write('PASS: pnpm dev started web, server, and a database-connected worker.\n');

  const browser = spawn(process.execPath, [packageManager, 'test:e2e'], {
    cwd: process.cwd(),
    env: { ...environment, PLAYWRIGHT_BASE_URL: baseUrl, PLAYWRIGHT_MODE: 'development' },
    stdio: 'inherit',
    windowsHide: true,
  });
  const browserExit = await new Promise<number | null>((done, reject) => {
    browser.once('error', () => {
      reject(new Error('The browser smoke-test process could not start.'));
    });
    browser.once('exit', done);
  });
  assert.equal(browserExit, 0, 'Browser smoke tests must pass.');

  process.kill(workerPid, 'SIGKILL');
  const stopped = await waitForHealth('degraded', 25_000);
  assert.equal(stopped.services.database.status, 'ok');
  assert.equal(stopped.services.worker.activeCount, 0);
  assert.ok(['missing', 'stale'].includes(stopped.services.worker.status));
  process.stdout.write(
    'PASS: terminating the worker produced HTTP 503 with the database still OK.\n',
  );

  const replacement = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/index.ts'], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'pipe',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  capture(replacement);
  const recovered = await waitForHealth('ok', 20_000);
  assert.ok(recovered.services.worker.activeCount >= 1);
  process.stdout.write(
    'PASS: a replacement worker restored HTTP 200 without restarting the API or web.\n',
  );
  await mkdir('.verification', { recursive: true });
  await writeFile(
    resolve('.verification/dev-smoke.json'),
    JSON.stringify(
      {
        command: 'pnpm dev',
        healthy,
        stopped,
        recovered,
        browser: 'passed',
        testedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
} catch (error: unknown) {
  process.stderr.write(
    error instanceof Error ? `${error.message}\n` : 'Development smoke test failed.\n',
  );
  // Application logs already use the redaction sink. Keep them local for diagnosis.
  await mkdir('.verification', { recursive: true });
  await writeFile(resolve('.verification/dev-smoke.log'), output.join(''));
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) await stop(child);
}
