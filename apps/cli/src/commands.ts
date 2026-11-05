import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readInfraConfig, readPlumbing } from '@sazuz/config';
import { passwordSchema, vaultStatusSchema } from '@sazuz/config/contracts';
import { healthSchema } from '@sazuz/core';
import { controlSchema } from '@sazuz/core/missions';
import { z } from 'zod';
import { runEvalCli } from './eval.js';
import { runAuditCli } from './audit.js';
import { runOperationsCli } from './operations.js';

export const commandSchema = z.tuple([
  z.enum(['doctor', 'reset-admin', 'unlock', 'setup-token', 'pause', 'resume']),
]);

async function changeControl(serverUrl: string, operatorKey: string, paused: boolean) {
  const url = new URL('/api/operator/control', serverUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Run pause and resume against the local Sazuz server.');
  const headers = { authorization: `Bearer ${operatorKey}`, 'content-type': 'application/json' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!read.ok)
      throw new Error(
        'Execution controls are unavailable. Check the local server and operator access.',
      );
    const current = controlSchema.parse(await read.json());
    if (current.paused === paused) return false;
    const write = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ paused, version: current.version }),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (write.status === 409) {
      await write.body?.cancel();
      continue;
    }
    if (!write.ok)
      throw new Error('Execution control failed. Check the local server and operator access.');
    const updated = controlSchema.parse(await write.json());
    if (updated.paused !== paused)
      throw new Error('The server did not confirm the requested execution state.');
    return true;
  }
  throw new Error('Execution controls changed repeatedly. Run the command again.');
}
export async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error(
      'A private interactive terminal is required. Secrets cannot be passed as command arguments.',
    );
  process.stdout.write(`${label}: `);
  const hidden = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const reader = createInterface({ input: process.stdin, output: hidden, terminal: true });
  return new Promise((resolve, reject) => {
    reader.once('SIGINT', () => {
      reader.close();
      reject(new Error('Command cancelled.'));
    });
    reader.question('', (answer) => {
      reader.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}
export async function runCli(
  args: string[],
  prompt = promptSecret,
  output: (message: string) => void = (message) => {
    process.stdout.write(`${message}\n`);
  },
) {
  if (args[0] === 'eval') return runEvalCli(args.slice(1), output);
  if (args[0] === 'audit') return runAuditCli(args.slice(1), output);
  if (
    [
      'backup',
      'restore-upload',
      'restore-complete',
      'update-prepare',
      'update-activate',
      'update-local',
    ].includes(args[0] ?? '')
  )
    return runOperationsCli(args, prompt, output);
  const result = commandSchema.safeParse(args);
  if (!result.success)
    throw new Error(
      'Usage: sazuz doctor | reset-admin | unlock | setup-token | pause | resume | eval run',
    );
  const [command] = result.data;
  const config = readInfraConfig();
  if (command === 'doctor') {
    const response = await fetch(new URL('/api/health', config.serverUrl), {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    const health = healthSchema.parse(await response.json());
    output(
      `Database: ${health.services.database.status}; worker: ${health.services.worker.status}.`,
    );
    if (health.status !== 'ok')
      throw new Error('Sazuz needs attention. Check service status and logs.');
    return;
  }
  if (command === 'setup-token') {
    const response = await fetch(new URL('/api/setup/status', config.serverUrl), {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    const state = z.object({ completed: z.boolean() }).parse(await response.json());
    if (state.completed) {
      output('Setup is already complete.');
      return;
    }
    const token = z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse((await readFile(join(config.dataDir, 'secrets/setup-token'), 'utf8')).trim());
    // Explicit local provisioning output; never sent to the logging subsystem.
    output(`Setup token: ${token}`);
    return;
  }
  const plumbing = await readPlumbing(config.dataDir);
  if (command === 'pause' || command === 'resume') {
    const changed = await changeControl(
      config.serverUrl,
      plumbing.operatorKey,
      command === 'pause',
    );
    output(
      command === 'pause'
        ? changed
          ? 'All agents paused. In-flight actions are stopping.'
          : 'All agents are already paused.'
        : changed
          ? 'Global pause cleared. Runs paused by the kill switch can resume.'
          : 'The global kill switch is already clear.',
    );
    return;
  }
  const secret = await prompt(
    command === 'unlock' ? 'Vault passphrase or recovery key' : 'New admin password',
  );
  if (command === 'reset-admin') {
    if (!passwordSchema.safeParse(secret).success)
      throw new Error('Use at least 12 characters with a letter and a number or symbol.');
    if (secret !== (await prompt('Repeat new admin password')))
      throw new Error('Passwords do not match.');
  }
  const response = await fetch(new URL(`/api/operator/${command}`, config.serverUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${plumbing.operatorKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(command === 'unlock' ? { passphrase: secret } : { password: secret }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      command === 'unlock'
        ? 'Vault unlock failed. Check the credential and retry later.'
        : 'Admin reset failed. Check that the server is running locally.',
    );
  if (command === 'unlock') vaultStatusSchema.parse(await response.json());
  else z.object({ ok: z.literal(true) }).parse(await response.json());
  output(
    command === 'unlock'
      ? 'Vault unlocked.'
      : 'Admin password reset. Existing sessions and two-factor enrollment were revoked. Sign in and enroll again.',
  );
}
