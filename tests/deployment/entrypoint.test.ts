import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const workspace = fileURLToPath(new URL('../..', import.meta.url));
const scratchRoot = join(workspace, '.verification');
const canary = 'canary-deployment-credential-never-print';
const moduleBody = `process.stdout.write(JSON.stringify({
  entry: import.meta.url, argv: process.argv.slice(1),
  hostname: process.env.HOSTNAME, port: process.env.PORT,
}));\n`;

const roles = [
  ['bootstrap', 'dist/bootstrap.js'],
  ['migrate', 'dist/migrate.js'],
  ['server', 'apps/server/dist/index.js'],
  ['worker', 'apps/worker/dist/index.js'],
  ['web', 'web/apps/web/server.js'],
] as const;

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe('production role entrypoint', () => {
  let fixture = '';

  beforeAll(async () => {
    await mkdir(scratchRoot, { recursive: true });
    fixture = await mkdtemp(join(scratchRoot, 'entrypoint-test-'));
    await mkdir(join(fixture, 'deploy'));
    await writeFile(join(fixture, 'package.json'), '{"type":"module"}\n');
    await copyFile(
      join(workspace, 'deploy/entrypoint.mjs'),
      join(fixture, 'deploy/entrypoint.mjs'),
    );
    await symlink(join(workspace, 'node_modules'), join(fixture, 'node_modules'), 'junction');
    for (const [, target] of roles) {
      const file = join(fixture, target);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, moduleBody);
    }
    await writeFile(
      join(fixture, 'dist/web-live-gateway.js'),
      'export async function startWebLiveGateway() {}',
    );
  });

  beforeEach(async () => {
    await writeFile(join(fixture, 'dist/bootstrap.js'), moduleBody);
  });

  afterAll(async () => {
    if (!fixture) return;
    const target = resolve(fixture);
    if (!target.startsWith(`${resolve(scratchRoot)}${sep}`)) {
      throw new Error('Refusing to remove a fixture outside the test scratch directory.');
    }
    await rm(target, { recursive: true, force: true });
  });

  function run(args: readonly string[]): Promise<Result> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [join(fixture, 'deploy/entrypoint.mjs'), ...args], {
        cwd: fixture,
        env: { ...process.env, HOSTNAME: 'container-hostname', PORT: '9999' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 4_000,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => resolveResult({ code, stdout, stderr }));
    });
  }

  it.each(roles)('starts the %s role from its production artifact', async (role, relativePath) => {
    const result = await run([role]);
    expect(result.code, result.stderr).toBe(0);
    const output: unknown = JSON.parse(result.stdout);
    const target = join(fixture, relativePath);
    expect(output).toMatchObject({ entry: pathToFileURL(target).href, argv: [target] });
    if (role === 'web') {
      expect(output).toMatchObject({ hostname: '0.0.0.0', port: '7777' });
    }
  });

  it.each([
    { name: 'missing role', args: [] },
    { name: 'unknown role', args: [canary] },
    { name: 'unexpected argument', args: ['server', canary] },
  ])('rejects $name without echoing arguments', async ({ args }) => {
    const result = await run(args);
    expect(result.code).toBe(64);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Choose one Sazuz role');
    expect(result.stderr).not.toContain(canary);
  });

  it('reports import failures without leaking exception content', async () => {
    await writeFile(
      join(fixture, 'dist/bootstrap.js'),
      `throw new Error(${JSON.stringify(canary)});\n`,
    );
    const result = await run(['bootstrap']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('The Sazuz role could not start');
    expect(result.stderr).not.toContain(canary);
  });

  it('fails when a required production artifact is missing', async () => {
    await unlink(join(fixture, 'dist/bootstrap.js'));
    const result = await run(['bootstrap']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('The Sazuz role could not start');
    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  });

  it('preserves a utility role failure exit status', async () => {
    await writeFile(join(fixture, 'dist/bootstrap.js'), 'process.exitCode = 23;\n');
    const result = await run(['bootstrap']);
    expect(result.code).toBe(23);
  });
});
