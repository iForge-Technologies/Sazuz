import { spawn } from 'node:child_process';
import { z } from 'zod';

// Build/dev tool telemetry is disabled by the workspace, without requiring user environment edits.
const task = z.enum(['build', 'typecheck']).parse(process.argv[2]);
const packageManager = process.env.npm_execpath;
if (packageManager === undefined) throw new Error('Run workspace tasks through pnpm.');
const environment = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', TURBO_TELEMETRY_DISABLED: '1' };

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [packageManager!, ...args], {
      stdio: 'inherit',
      env: environment,
    });
    child.once('error', () => {
      reject(new Error('Could not launch the workspace task.'));
    });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('Workspace task failed.'));
    });
  });
}

try {
  await run(['exec', 'turbo', 'run', task]);
  await run(
    task === 'build'
      ? ['exec', 'tsup']
      : ['exec', 'tsc', '--noEmit', '-p', 'tsconfig.scripts.json'],
  );
} catch {
  process.stderr.write(`Sazuz ${task} failed; see the check output above.\n`);
  process.exitCode = 1;
}
