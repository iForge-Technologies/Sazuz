import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { mkdir, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { readInfraConfig, readOperatorKey } from '@sazuz/config';
import { freshSettings } from '@sazuz/config/settings';
import { workKey } from '@sazuz/db';
import {
  buildContainer,
  containerName,
  decodeLogs,
  dockerEngine,
  issueGrant,
  waitContainer,
  type ContainerEngine,
} from '@sazuz/sandbox';
import { sandboxAcceptanceCode } from './sandbox-acceptance-code.js';

/** Run inside the Compose worker. It has no raw Docker socket and uses the production proxy. */
async function verifySandbox() {
  const config = readInfraConfig();
  const key = await readOperatorKey(config.dataDir);
  const projectId = workKey('prj'),
    runId = workKey('run');
  const workspaceRoot = resolve(config.dataDir, 'workspace');
  const workspace = resolve(workspaceRoot, projectId);
  if (!workspace.startsWith(workspaceRoot + sep))
    throw new Error('Invalid verification workspace.');
  await mkdir(workspace, { recursive: false, mode: 0o700 });
  const active: { name: string; engine: ContainerEngine }[] = [];
  let passed = 0;
  async function create(
    language: 'python' | 'node',
    network: boolean,
    code: string,
    durationMs: number,
    proxyDeadline = false,
  ) {
    const callKey = `${runId}:${active.length + 1}:0`,
      name = containerName(callKey);
    const expiresAt = Date.now() + durationMs;
    const scope = {
      subject: name,
      projectId,
      agentId: 'analyst',
      domains: network ? ['example.com'] : [],
    };
    const token = issueGrant(key, { ...scope, service: 'docker', expiresAt: expiresAt + 30000 });
    const engine = dockerEngine(config, token);
    const spec = buildContainer({
      args: { language, code, network: network ? 'allowlist' : 'none' },
      projectId,
      runId,
      key: callKey,
      expiresAt,
      settings: { ...freshSettings().sandbox.value, memoryMb: 512 },
      config,
      ...(network
        ? { proxyToken: issueGrant(key, { ...scope, service: 'egress', expiresAt }) }
        : {}),
    });
    if (proxyDeadline) spec.Cmd[1] = '60000'; // The proxy must kill it before the fixed runner's timer.
    active.push({ name, engine });
    await engine.create(name, spec);
    await engine.start(name);
    return { name, engine, expiresAt };
  }
  try {
    const peers = await Promise.all(
      ['postgres', 'egress-proxy'].map(async (name) => (await lookup(name, { family: 4 })).address),
    );
    for (const language of ['python', 'node'] as const)
      for (const admitted of [false, true]) {
        const receipt = `${language}-${admitted ? 'admitted' : 'offline'}.txt`;
        const item = await create(
          language,
          admitted,
          sandboxAcceptanceCode(language, admitted, peers, receipt),
          60000,
        );
        // This client resumes an already-started deterministic container; it never starts it again.
        const result = await waitContainer(
          item.engine,
          item.name,
          item.expiresAt,
          AbortSignal.timeout(65000),
        );
        assert.equal(
          result.exitCode,
          0,
          `${language}: container acceptance failed; inspect only sanitized execution output.`,
        );
        const output = decodeLogs(await item.engine.logs(item.name));
        const value = z
          .strictObject({
            admitted: z.boolean(),
            blockedDirect: z.number().int().min(4),
            receipt: z.literal(1),
            hardened: z.literal(true),
          })
          .parse(JSON.parse(output.output.trim()));
        assert.equal(value.admitted, admitted);
        assert.equal(output.truncated, false);
        assert.equal((await item.engine.inspect(item.name))?.State.Status, 'exited');
        passed++;
        process.stdout.write(
          `PASS ${language}: ${admitted ? 'allowlisted HTTPS' : 'offline'}, direct/DNS/private/peer denial, hardening, one execution.\n`,
        );
      }
    for (const language of ['python', 'node'] as const) {
      const item = await create(
        language,
        false,
        language === 'python' ? 'while True: pass' : 'while (true) {}',
        2500,
        true,
      );
      let stopped = false;
      for (let attempt = 0; attempt < 16; attempt++) {
        await delay(500);
        const state = await item.engine.inspect(item.name);
        if (state && !state.State.Running) {
          assert.equal(state.State.ExitCode, 137);
          stopped = true;
          break;
        }
      }
      assert.equal(
        stopped,
        true,
        `${language}: the independent proxy deadline did not stop the container.`,
      );
      passed++;
      process.stdout.write(`PASS ${language}: independent proxy deadline.\n`);
    }
    process.stdout.write(`Docker sandbox acceptance: ${passed}/6 passed.\n`);
  } finally {
    for (const item of active) {
      try {
        if ((await item.engine.inspect(item.name))?.State.Running)
          await item.engine.stop(item.name);
        await item.engine.remove(item.name);
      } catch {
        process.stderr.write('An owned acceptance container needs proxy cleanup.\n');
        process.exitCode = 1;
      }
    }
    if (resolve(workspace).startsWith(workspaceRoot + sep))
      await rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--run') {
  try {
    await verifySandbox();
  } catch {
    process.stderr.write(
      'Docker sandbox acceptance failed. Verify the running core profile, built sandbox images, and outbound HTTPS to example.com. No container acceptance is claimed.\n',
    );
    process.exitCode = 1;
  }
} else {
  process.stdout.write(
    'Run on a Docker host: docker compose exec -T worker node /app/dist/sandbox-acceptance.js --run\n',
  );
}
