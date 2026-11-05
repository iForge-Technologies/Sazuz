import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bridgeInputs, bridgeRequestSchema, type BridgeTool } from '@sazuz/core/bridge';
import { BridgeState } from './state.js';
import { createLocalExecutor, requestHash } from './local-execution.js';
import { localPin, manifest, prepareLocalConfiguration } from './local-config.js';
import { scopedPath } from './filesystem.js';
import { assertNarrower } from './store.js';
import { runFixedCommand } from './commands.js';

const deviceId = 'brg_01K00000000000000000000000',
  projectId = 'prj_01K00000000000000000000000';
describe('real Bridge filesystem, commands and encrypted durable receipts', () => {
  let directory: string, root: string, outside: string, state: BridgeState, pin: string;
  let execute: ReturnType<typeof createLocalExecutor>;
  const token = 'bridge-local-secret-canary-816529734028';
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sazuz-bridge-test-'));
    root = join(directory, 'scope');
    outside = join(directory, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, 'marker.txt'), 'authorized folder marker');
    await writeFile(join(outside, 'outside.txt'), 'outside-scope-marker');
    await writeFile(
      join(root, 'command.cjs'),
      "const fs=require('node:fs'); const file='counter.txt'; fs.writeFileSync(file,String(Number(fs.existsSync(file)?fs.readFileSync(file,'utf8'):0)+1)); console.log('fixed command');",
    );
    state = await BridgeState.create(
      join(directory, 'state'),
      'companion-test-passphrase-913',
      {
        deviceId,
        projectId,
        endpoint: 'ws://127.0.0.1:7777/bridge',
        token,
      },
      {
        folders: [
          { alias: 'notes', root, mode: 'write', delete: true },
          { alias: 'readonly', root: outside, mode: 'read' },
        ],
        commands: [
          {
            alias: 'increment',
            executable: process.execPath,
            args: [join(root, 'command.cjs')],
            folder: 'notes',
          },
        ],
      },
    );
    pin = localPin(await state.configuration());
    execute = createLocalExecutor(state);
  }, 60000);
  afterAll(async () => {
    state?.close();
    if (
      directory &&
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
      directory.includes('sazuz-bridge-test-')
    )
      await rm(directory, { recursive: true, force: true });
  });
  function request(tool: BridgeTool, args: Record<string, unknown>, verify = false) {
    return bridgeRequestSchema.parse({
      type: 'request',
      id: randomUUID(),
      deviceId,
      projectId,
      agentId: 'operator',
      key: `fixture:${randomUUID()}`,
      pin,
      version: 1,
      tool,
      args: bridgeInputs[tool].parse({ deviceId, ...args }),
      deadline: Date.now() + 30000,
      verify,
    });
  }
  const signal = () => new AbortController().signal;
  it('reads the authorized marker, lists ordinary files and enforces portable path boundaries', async () => {
    const result = await execute(
      request('local.fs.read', { folder: 'notes', path: 'marker.txt' }),
      signal(),
    );
    expect(result).toMatchObject({
      status: 'done',
      output: { content: 'authorized folder marker' },
    });
    const listing = await execute(
      request('local.fs.list', { folder: 'notes', path: '' }),
      signal(),
    );
    expect(JSON.stringify(listing)).toContain('marker.txt');
    const config = await state.configuration();
    for (const path of [
      '../outside/outside.txt',
      '/outside/outside.txt',
      'C:/Windows/test',
      'a\\..\\outside',
      'file:stream',
      'NUL.txt',
      'CON',
      'com1.txt',
      'a/./b',
      'a//b',
      'a.',
    ])
      await expect(scopedPath(config, state.directory, 'notes', path)).rejects.toThrow();
    await expect(scopedPath(config, state.directory, 'missing', 'marker.txt')).rejects.toThrow();
  }, 60000);
  it('rejects junction/symlink and hard-link escapes and credential-directory scopes', async () => {
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await link(join(outside, 'outside.txt'), join(root, 'linked.txt'));
    const config = await state.configuration();
    await expect(
      scopedPath(config, state.directory, 'notes', 'escape/outside.txt'),
    ).rejects.toThrow();
    await expect(scopedPath(config, state.directory, 'notes', 'linked.txt')).rejects.toThrow();
    await expect(
      prepareLocalConfiguration(
        { folders: [{ alias: 'all', root: directory, mode: 'write' }], commands: [] },
        state.directory,
      ),
    ).rejects.toThrow();
  });
  it('writes, moves without overwriting and deletes only inside an explicitly writable folder', async () => {
    await execute(
      request('local.fs.write', { folder: 'notes', path: 'draft.txt', content: 'local draft' }),
      signal(),
    );
    expect(await readFile(join(root, 'draft.txt'), 'utf8')).toBe('local draft');
    await execute(
      request('local.fs.move', { folder: 'notes', path: 'draft.txt', destination: 'moved.txt' }),
      signal(),
    );
    expect(await readFile(join(root, 'moved.txt'), 'utf8')).toBe('local draft');
    await expect(
      execute(
        request('local.fs.move', { folder: 'notes', path: 'moved.txt', destination: 'marker.txt' }),
        signal(),
      ),
    ).rejects.toThrow();
    await execute(request('local.fs.delete', { folder: 'notes', path: 'moved.txt' }), signal());
    await expect(readFile(join(root, 'moved.txt'))).rejects.toThrow();
    await expect(
      execute(
        request('local.fs.write', { folder: 'readonly', path: 'blocked.txt', content: 'denied' }),
        signal(),
      ),
    ).rejects.toThrow();
    await expect(readFile(join(outside, 'blocked.txt'))).rejects.toThrow();
  }, 60000);
  it('executes a pinned fixed vector once, replays its receipt after restart and rejects caller arguments', async () => {
    const message = request('local.exec', { command: 'increment' });
    expect(await execute(message, signal())).toMatchObject({
      status: 'done',
      output: { exitCode: 0, output: 'fixed command\n' },
    });
    state.close();
    state = await BridgeState.open(join(directory, 'state'));
    execute = createLocalExecutor(state);
    expect(
      await execute({ ...message, id: randomUUID(), deadline: Date.now() + 30000 }, signal()),
    ).toMatchObject({ status: 'done' });
    expect(await readFile(join(root, 'counter.txt'), 'utf8')).toBe('1');
    expect(() =>
      bridgeInputs['local.exec'].parse({ deviceId, command: 'increment', args: ['arbitrary'] }),
    ).toThrow();
    await writeFile(join(root, 'command.cjs'), "console.log('substituted script')");
    await expect(
      execute(request('local.exec', { command: 'increment' }), signal()),
    ).rejects.toThrow();
    expect(await readFile(join(root, 'counter.txt'), 'utf8')).toBe('1');
  }, 60000);
  it('keeps an interrupted effect uncertain and rejects expired, aborted and changed requests', async () => {
    const message = request('local.fs.write', {
      folder: 'notes',
      path: 'uncertain.txt',
      content: 'must not repeat',
    });
    await state.write(state.receiptName(message.key, 'start'), {
      key: message.key,
      hash: requestHash(message),
    });
    expect(await execute(message, signal())).toEqual({ status: 'unknown' });
    await expect(readFile(join(root, 'uncertain.txt'))).rejects.toThrow();
    await expect(
      execute({ ...message, args: { ...message.args, content: 'retarget' } }, signal()),
    ).rejects.toThrow();
    await expect(execute({ ...message, deadline: Date.now() - 1 }, signal())).rejects.toThrow();
    await expect(execute(message, AbortSignal.abort())).rejects.toThrow();
    expect(
      await execute(
        request(
          'local.fs.write',
          { folder: 'notes', path: 'never-dispatched.txt', content: 'read receipt only' },
          true,
        ),
        signal(),
      ),
    ).toEqual({ status: 'not_done' });
    await expect(execute({ ...message, pin: 'a'.repeat(64) }, signal())).rejects.toThrow();
  }, 60000);
  it('redacts token canaries and keeps configuration and result contents encrypted on disk', async () => {
    await writeFile(join(root, 'secret-marker.txt'), token);
    const result = await execute(
      request('local.fs.read', { folder: 'notes', path: 'secret-marker.txt' }),
      signal(),
    );
    expect(JSON.stringify(result)).not.toContain(token);
    const files = await readdir(join(state.directory, 'secrets'));
    for (const name of files.filter((item) => item.endsWith('.vault'))) {
      const bytes = await readFile(join(state.directory, 'secrets', name), 'utf8');
      expect(bytes).not.toContain(token);
      expect(bytes).not.toContain('authorized folder marker');
      expect(bytes).not.toContain('local draft');
      expect(bytes).not.toContain(root);
    }
    const offered = manifest(await state.configuration());
    expect(() =>
      assertNarrower(
        {
          ...offered,
          pin,
          agents: ['operator'],
          tools: ['local.fs.read'],
          folders: [{ alias: 'outside', mode: 'write', delete: true }],
        },
        offered,
      ),
    ).toThrow();
    expect(() =>
      assertNarrower({ ...offered, pin, agents: [], tools: [], privateOnly: false }, offered),
    ).toThrow();
  }, 60000);
  it('admits only one durable start claimant and stops commands on abort or excessive output', async () => {
    const name = state.receiptName('concurrent-claim', 'start');
    const claims = await Promise.all([
      state.write(name, { marker: true }),
      state.write(name, { marker: true }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(
      runFixedCommand(
        process.execPath,
        ['-e', 'setInterval(() => {},1000)'],
        root,
        AbortSignal.timeout(500),
      ),
    ).rejects.toThrow();
    await expect(
      runFixedCommand(
        process.execPath,
        ['-e', "process.stdout.write('a'.repeat(5000))"],
        root,
        signal(),
      ),
    ).rejects.toThrow();
  }, 20000);
});
