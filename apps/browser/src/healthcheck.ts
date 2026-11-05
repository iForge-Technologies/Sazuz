import { readInfraConfig, readOperatorKey } from '@sazuz/config';
import { createBrowserClient } from '@sazuz/browser';
try {
  const config = readInfraConfig();
  const client = createBrowserClient({ browserUrl: 'http://127.0.0.1:7779' }, () =>
    readOperatorKey(config.dataDir),
  );
  const health = await client({ mode: 'health' }, AbortSignal.timeout(3000));
  if (!health.ready) process.exitCode = 1;
} catch {
  process.stderr.write('Browser health is unavailable.\n');
  process.exitCode = 1;
}
