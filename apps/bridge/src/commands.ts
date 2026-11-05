import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { z } from 'zod';
import { BridgeError } from '@sazuz/core/bridge';
import { secretRedactor } from '@sazuz/vault';
import { BridgeState, localInputSchema, localPin, manifest, runBridge } from '@sazuz/bridge/local';

const command = z.enum(['pair', 'configure', 'run', 'inspect']);
export const bridgeCliArgs = z.union([
  z.tuple([command]),
  z.tuple([command, z.literal('--state'), z.string().min(1).max(2048)]),
]);
export interface BridgePrompts {
  line(label: string): Promise<string>;
  secret(label: string): Promise<string>;
}
export function terminalQuestion(label: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) throw new BridgeError('BRIDGE_DENIED');
  process.stdout.write(`${label}: `);
  const output = hidden
    ? new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      })
    : process.stdout;
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve, reject) => {
    reader.once('SIGINT', () => {
      reader.close();
      reject(new BridgeError('BRIDGE_DENIED'));
    });
    reader.question('', (answer) => {
      reader.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}
const terminal: BridgePrompts = {
  line: (label) => terminalQuestion(label),
  secret: (label) => terminalQuestion(label, true),
};
async function scopes(prompt: BridgePrompts) {
  const folders: z.input<typeof localInputSchema>['folders'] = [];
  while (folders.length < 16) {
    const alias = (await prompt.line('Folder alias (blank to finish folders)')).trim();
    if (!alias) break;
    const root = (await prompt.line('Absolute folder path')).trim();
    const write =
      (await prompt.line('Allow file writes in this folder (yes/no, default no)')) === 'yes';
    const remove =
      write && (await prompt.line('Allow individual file deletion (yes/no, default no)')) === 'yes';
    folders.push({ alias, root, mode: write ? 'write' : 'read', delete: remove });
  }
  const commands: z.input<typeof localInputSchema>['commands'] = [];
  while (commands.length < 16) {
    const alias = (await prompt.line('Fixed command alias (blank to finish commands)')).trim();
    if (!alias) break;
    const executable = (await prompt.line('Absolute executable path (no shell)')).trim();
    const args: unknown = JSON.parse(
      await prompt.line('Exact arguments as a JSON array (use [] for none)'),
    );
    const folder = (await prompt.line('Writable folder alias for the working directory')).trim();
    const files: unknown = JSON.parse(
      await prompt.line('Additional script/module paths to pin as a JSON array (use [] for none)'),
    );
    commands.push({
      alias,
      executable,
      args: z.array(z.string()).parse(args),
      folder,
      files: z.array(z.string()).parse(files),
    });
  }
  const notifications =
    (await prompt.line('Enable native notifications (yes/no, default no)')) === 'yes';
  const privateOnly =
    (await prompt.line(
      'Allow cloud model processing of these folder/command results (yes/no, default no)',
    )) !== 'yes';
  return localInputSchema.parse({ folders, commands, notifications, privateOnly });
}
export async function runBridgeCli(
  args: string[],
  options: {
    prompt?: BridgePrompts;
    output?: (message: string) => void;
    signal?: AbortSignal;
  } = {},
) {
  const parsed = bridgeCliArgs.safeParse(args);
  if (!parsed.success)
    throw new Error(
      'Usage: sazuz-bridge pair | configure | inspect | run [--state <private-directory>]',
    );
  const [action, , path] = parsed.data;
  const directory = resolve(path ?? join(homedir(), '.sazuz-bridge'));
  const prompt = options.prompt ?? terminal,
    output =
      options.output ??
      ((message: string) => {
        process.stdout.write(message + '\n');
      });
  let state: BridgeState;
  if (action === 'pair') {
    const endpoint = (
      await prompt.line('Sazuz WSS endpoint ending in /bridge (loopback WS allowed)')
    ).trim();
    const deviceId = (await prompt.line('Device ID from Connectors')).trim();
    const projectId = (await prompt.line('Project ID from Connectors')).trim();
    const token = await prompt.secret('Device vault credential');
    secretRedactor.register(token);
    const passphrase = await prompt.secret('Companion vault passphrase (12+ characters)');
    secretRedactor.register(passphrase);
    if (passphrase !== (await prompt.secret('Repeat companion vault passphrase')))
      throw new BridgeError('BRIDGE_INVALID');
    const configuration = await scopes(prompt);
    output(JSON.stringify(secretRedactor.redact(configuration), null, 2));
    if ((await prompt.line('Save these local scopes (yes/no)')) !== 'yes')
      throw new BridgeError('BRIDGE_DENIED');
    state = await BridgeState.create(
      directory,
      passphrase,
      { endpoint, deviceId, projectId, token },
      configuration,
    );
  } else state = await BridgeState.open(directory);
  try {
    if (action === 'configure') {
      const configuration = await scopes(prompt);
      output(JSON.stringify(secretRedactor.redact(configuration), null, 2));
      if (
        (await prompt.line('Save these local scopes and require server review (yes/no)')) !== 'yes'
      )
        throw new BridgeError('BRIDGE_DENIED');
      await state.configure(configuration);
    }
    const config = await state.configuration();
    output(`Local configuration pin: ${localPin(config)}`);
    if (action === 'inspect') output(JSON.stringify(manifest(config), null, 2));
    else if (action === 'run')
      await runBridge(state, options.signal ?? new AbortController().signal, output);
    else
      output(
        'Local scopes saved. Run sazuz-bridge run, compare the pin in Connectors, then review the device grant.',
      );
  } finally {
    state.close();
  }
}
