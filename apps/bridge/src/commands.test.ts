import { expect, it } from 'vitest';
import { bridgeCliArgs, runBridgeCli } from './commands.js';

it('rejects command-line credentials and unknown Bridge commands', async () => {
  for (const args of [
    ['pair', '--token', 'plaintext'],
    ['run', '--url', 'ws://outside/bridge'],
    ['exec', 'arbitrary'],
    ['pair', 'credential'],
  ]) {
    expect(bridgeCliArgs.safeParse(args).success).toBe(false);
    await expect(runBridgeCli(args)).rejects.toThrow('Usage');
  }
  expect(bridgeCliArgs.safeParse(['run', '--state', '/private-companion']).success).toBe(true);
});
