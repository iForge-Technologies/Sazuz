import { readInfraConfig, readOperatorKey } from '@sazuz/config';
import { createLogger } from '@sazuz/core';
import { createDatabase, type Database } from '@sazuz/db';
import { secretRedactor } from '@sazuz/vault';
import { createBrowserApp } from './app.js';

const logger = createLogger('browser', secretRedactor);
let database: Database | undefined;
let service: Awaited<ReturnType<typeof createBrowserApp>> | undefined;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try {
    await service?.app.close();
    await database?.close();
  } catch {
    logger.error({ code: 'BROWSER_CLOSE_FAILED' }, 'Browser shutdown failed.');
    process.exitCode = 1;
  }
}
try {
  const config = readInfraConfig();
  database = await createDatabase(config, logger);
  service = await createBrowserApp({
    database,
    key: await readOperatorKey(config.dataDir),
    egressUrl: config.egressProxyUrl,
  });
  await service.app.listen({ host: '0.0.0.0', port: 7779 });
  logger.info({ event: 'browser.ready' }, 'The browser service is listening.');
  process.once('SIGINT', () => {
    void close();
  });
  process.once('SIGTERM', () => {
    void close();
  });
} catch {
  logger.error({ code: 'BROWSER_START_FAILED' }, 'The browser service could not start.');
  await close();
  process.exitCode = 1;
}
