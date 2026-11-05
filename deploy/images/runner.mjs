import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { startRelay } from './relay.mjs';

if (process.argv.length !== 4) process.exit(64);
let closeRelay;
try {
  const code = Buffer.from(process.argv[2], 'base64');
  const timeout = Number(process.argv[3]);
  if (
    !code.length ||
    code.length > 131072 ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 3600000
  )
    process.exit(64);
  await writeFile('/tmp/sazuz-task.mjs', code, { flag: 'wx', mode: 0o600 });
  if (process.env.HTTPS_PROXY) closeRelay = await startRelay();
  const child = spawn(process.execPath, ['/tmp/sazuz-task.mjs'], {
    stdio: 'inherit',
    shell: false,
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  child.once('error', () => {
    closeRelay?.();
    clearTimeout(timer);
    process.exitCode = 70;
  });
  child.once('exit', (status) => {
    closeRelay?.();
    clearTimeout(timer);
    process.exitCode = status ?? 124;
  });
} catch {
  closeRelay?.();
  process.stderr.write('Sandbox entrypoint could not prepare the task.\n');
  process.exitCode = 64;
}
