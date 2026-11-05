#!/usr/bin/env node
import { runBridgeCli } from './commands.js';
import { BridgeError } from '@sazuz/core/bridge';
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  await runBridgeCli(process.argv.slice(2), { signal: controller.signal });
} catch (error) {
  process.stderr.write(
    `${error instanceof BridgeError ? error.code : 'BRIDGE_COMMAND_FAILED'}: Check the command, local scopes and encrypted device state. Secrets must be entered in an interactive terminal.\n`,
  );
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
