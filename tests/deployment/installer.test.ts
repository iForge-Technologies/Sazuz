import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Windows installer command boundary', () => {
  it.skipIf(process.platform !== 'win32')(
    'selects a free port, protects data, and preserves its generated configuration on rerun',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sazuz-installer-test-'));
      const fakeBin = join(root, 'bin');
      await mkdir(fakeBin);
      await mkdir(join(root, 'deploy'));
      await cp(resolve('install.ps1'), join(root, 'install.ps1'));
      await cp(resolve('sazuz.ps1'), join(root, 'sazuz.ps1'));
      await writeFile(join(root, 'deploy/compose.yaml'), 'services: {}\n');
      await writeFile(
        join(fakeBin, 'docker.cmd'),
        '@echo off\necho %*>>"%INSTALLER_CALL_LOG%"\nexit /b 0\n',
      );
      const calls = join(root, 'calls.txt');
      const occupied = createServer();
      await new Promise<void>((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(7777, '127.0.0.1', resolve);
      });
      const run = () =>
        new Promise<number | null>((resolve, reject) => {
          const child = spawn(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              join(root, 'install.ps1'),
              '-NoOpen',
              '-NoPathUpdate',
            ],
            {
              windowsHide: true,
              stdio: 'ignore',
              env: {
                ...process.env,
                PATH: `${fakeBin};${process.env.PATH ?? ''}`,
                LOCALAPPDATA: join(root, 'local'),
                INSTALLER_CALL_LOG: calls,
              },
            },
          );
          child.once('error', reject);
          child.once('exit', resolve);
        });
      try {
        expect(await run()).toBe(0);
        const first = await readFile(join(root, 'data/compose.install.yaml'), 'utf8');
        expect(first).toContain('127.0.0.1:7778:7777');
        expect(await run()).toBe(0);
        expect(await readFile(join(root, 'data/compose.install.yaml'), 'utf8')).toBe(first);
        const log = await readFile(calls, 'utf8');
        expect(log).toContain('up --detach --build --wait');
        expect(log).toContain('setup-token');
        expect(log).not.toContain('--volumes');
        await writeFile(join(root, 'deploy/compose.release.yaml'), 'services: {}\n');
        expect(await run()).toBe(0);
        const bundledLog = await readFile(calls, 'utf8');
        expect(bundledLog).toContain('up --detach --no-build --pull missing --wait');
        expect(bundledLog.replaceAll('\\', '/')).toContain('deploy/compose.release.yaml');
      } finally {
        await new Promise<void>((resolve) => occupied.close(() => resolve()));
        if (
          resolve(root).startsWith(resolve(tmpdir()) + sep) &&
          root.includes('sazuz-installer-test-')
        )
          await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
