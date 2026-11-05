import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readInfraConfig, ConfigError } from '@sazuz/config';
import { startWebLiveGateway } from './web-live-gateway.js';

try {
  const config = readInfraConfig();
  const gateway = await startWebLiveGateway(config);
  const closeGateway = () => {
    void gateway.close().catch(() => {
      process.stderr.write('The live browser gateway could not close.\n');
      process.exitCode = 1;
    });
  };
  const next = fileURLToPath(
    new URL('../apps/web/node_modules/next/dist/bin/next', import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [next, 'dev', '--hostname', '127.0.0.1', '--port', String(config.webPort)],
    {
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    },
  );
  child.once('error', () => {
    closeGateway();
    process.stderr.write('Sazuz web development server could not start.\n');
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    closeGateway();
    process.exitCode = code ?? 1;
  });
  process.once('SIGTERM', () => {
    child.kill('SIGTERM');
  });
  process.once('SIGINT', () => {
    child.kill('SIGINT');
  });
} catch (error: unknown) {
  process.stderr.write(
    error instanceof ConfigError ? `${error.message}\n` : 'Web configuration is invalid.\n',
  );
  process.exitCode = 1;
}
