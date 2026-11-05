import { readInfraConfig } from '@sazuz/config';
import { createLogger, SazuzError } from '@sazuz/core';
import { createDatabase, readHealth, type Database } from '@sazuz/db';
import { secretRedactor } from '@sazuz/vault';
import { createApp } from './app.js';
import { createPhaseOne, type PhaseOne } from './phase-one.js';
import { registerPhaseOne } from './phase-one-routes.js';
import { registerPhaseTwo } from './phase-two.js';
import { registerPhaseThree } from './phase-three.js';
import { createDurableChat } from './phase-three-chat.js';
import { registerPhaseFour } from './phase-four.js';
import { registerPhaseFive } from './phase-five.js';
import { registerPhaseSix } from './phase-six.js';
import { registerPhaseSeven } from './phase-seven.js';
import { registerPhaseEight } from './phase-eight.js';
import { registerPhaseTen } from './phase-ten.js';
import { registerPhaseEleven } from './phase-eleven.js';

const logger = createLogger('server', secretRedactor);
let database: Database | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let closing = false;
let phaseOne: PhaseOne | undefined;

async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await app?.close();
    await phaseOne?.close();
    await database?.close();
    logger.info({ event: 'server.stopped' }, 'Server stopped.');
  } catch {
    logger.error({ code: 'SERVER_SHUTDOWN_FAILED' }, 'Server shutdown failed.');
    process.exitCode = 1;
  }
}

try {
  const config = readInfraConfig();
  database = await createDatabase(config, logger);
  const connectedDatabase = database;
  app = await createApp({ logger, health: () => readHealth(connectedDatabase) });
  phaseOne = await createPhaseOne(database, config);
  registerPhaseOne(app, phaseOne);
  registerPhaseTwo(app, phaseOne, undefined, { chat: createDurableChat(app, phaseOne) });
  registerPhaseThree(app, phaseOne);
  registerPhaseFour(app, phaseOne);
  registerPhaseFive(app, phaseOne);
  registerPhaseSix(app, phaseOne);
  registerPhaseSeven(app, phaseOne);
  registerPhaseEight(app, phaseOne);
  registerPhaseTen(app, phaseOne);
  registerPhaseEleven(app, phaseOne, {
    restored: () => {
      void shutdown().then(() => process.exit(process.exitCode ?? 0));
    },
  });
  await app.listen({ host: config.serverHost, port: config.serverPort });
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
} catch (error: unknown) {
  logger.error(
    { code: error instanceof SazuzError ? error.code : 'SERVER_STARTUP_FAILED' },
    'Server could not start.',
  );
  await shutdown();
  process.exitCode = 1;
}
