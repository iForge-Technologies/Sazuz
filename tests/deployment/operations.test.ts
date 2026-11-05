import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// An executable fixture records argv, provides binary pipes, and injects host failures.
// It does not start Docker, an application, a migration, or a network request.
const fake = `
const fs=require('node:fs'),crypto=require('node:crypto');
const args=process.argv.slice(1),statePath=process.env.SAZUZ_HOST_TEST_STATE;
args[0]=require('node:path').basename(args[0]);
fs.appendFileSync(process.env.SAZUZ_HOST_TEST_LOG,JSON.stringify(args)+'\\n');
const emit=value=>{fs.writeSync(1,value);process.exit(0)};
const save=value=>fs.writeFileSync(statePath,value);
const state=()=>fs.existsSync(statePath)?fs.readFileSync(statePath,'utf8'):'none';
const failure=process.env.SAZUZ_HOST_TEST_FAILURE;
const image='ghcr.io/example/sazuz@sha256:'+'a'.repeat(64);
if(args.includes('update-prepare')){JSON.parse(fs.readFileSync(0,'utf8'));save('backed-up');emit(image)}
if(args.includes('update-local')){
 const command=args.at(-1);
 if(command==='state')emit(state());if(command==='candidate')emit(image);
 const next=command==='rollback'?'restored':command==='finish-rollback'?'rolled-back':command==='reconcile'?'done':command==='abort'?'aborted':command;
 save(next);emit(next);
}
if(args.includes('update-activate')){if(failure==='activation'){save('activation-intent');process.exit(1)}save('done');emit('done')}
if(args.includes('backup')){let b=Buffer.alloc(70000);for(let i=0;i<b.length;i++)b[i]=i%256;let n=0;while(n<b.length)n+=fs.writeSync(1,b,n,b.length-n);process.exit(0)}
if(args.includes('restore-upload')){const b=fs.readFileSync(0);fs.appendFileSync(process.env.SAZUZ_HOST_TEST_LOG,JSON.stringify({uploadHash:crypto.createHash('sha256').update(b).digest('hex')})+'\\n');emit('op_01ARZ3NDEKTSV4RRFFQ69G5FAV')}
if(args.includes('ps'))emit('c'.repeat(64));if(args[0]==='inspect')emit('sha256:'+'b'.repeat(64));
if(failure==='migration'&&args.includes('run')&&args.at(-1)==='migrate')process.exit(1);
if(failure==='health'&&args.includes('up')&&args.some(v=>v.endsWith('compose.update.candidate.yaml')))process.exit(1);
process.exit(0);
`;
const shells =
  process.platform === 'win32' ? (['powershell', 'bash'] as const) : (['bash'] as const);
describe('trusted host operation vectors', () => {
  let directory: string, bin: string, preload: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "sazuz host's ops-"));
    bin = join(directory, 'bin');
    await mkdir(bin);
    preload = join(directory, 'fake.cjs');
    await writeFile(preload, fake);
    if (process.platform === 'win32') await cp(process.execPath, join(bin, 'docker.exe'));
    else
      await writeFile(
        join(bin, 'docker'),
        `#!/usr/bin/env bash\nexec '${process.execPath.replaceAll("'", "'\\''")}' --require '${preload.replaceAll("'", "'\\''")}' "$@"\n`,
        { mode: 0o700 },
      );
  });
  afterAll(async () => {
    if (
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
      directory.includes("sazuz host's ops-")
    )
      await rm(directory, { recursive: true, force: true });
  });
  async function fixture(label: string) {
    const root = join(directory, label);
    await mkdir(join(root, 'deploy'), { recursive: true });
    await mkdir(join(root, 'data'));
    for (const file of ['sazuz', 'sazuz.ps1', 'deploy/host-ops.ps1', 'deploy/host-ops.sh'])
      await cp(resolve(file), join(root, file));
    await writeFile(join(root, 'deploy/compose.yaml'), 'services: {}\n');
    await writeFile(
      join(root, 'release.json'),
      JSON.stringify({
        format: 1,
        version: '1.0.1',
        image: `ghcr.io/example/sazuz@sha256:${'a'.repeat(64)}`,
        notes: 'Reviewed release',
      }),
    );
    const log = join(root, 'calls.jsonl'),
      state = join(root, 'state');
    const run = (shell: string, args: string[], failure = '') =>
      new Promise<{ code: number | null; output: string }>((done, reject) => {
        const windows = process.platform === 'win32';
        const executable =
          shell === 'powershell'
            ? 'powershell.exe'
            : windows
              ? 'C:/Program Files/Git/bin/bash.exe'
              : 'bash';
        const vector =
          shell === 'powershell'
            ? [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                join(root, 'sazuz.ps1'),
                ...args,
              ]
            : [join(root, 'sazuz').replaceAll('\\', '/'), ...args];
        const child = spawn(executable, vector, {
          cwd: root,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: bin + delimiter + (process.env.PATH ?? ''),
            NODE_OPTIONS: windows ? `--require "${preload.replaceAll('\\', '/')}"` : '',
            MSYS_NO_PATHCONV: '1',
            SAZUZ_HOST_TEST_LOG: log,
            SAZUZ_HOST_TEST_STATE: state,
            SAZUZ_HOST_TEST_FAILURE: failure,
          },
        });
        let output = '';
        child.stdout.on('data', (value: Buffer) => {
          output += value.toString();
        });
        child.stderr.on('data', (value: Buffer) => {
          output += value.toString();
        });
        child.once('error', reject);
        child.once('close', (code) => done({ code, output }));
      });
    return { root, run, log, state };
  }
  for (const shell of shells) {
    const available =
      shell !== 'bash' ||
      process.platform !== 'win32' ||
      existsSync('C:/Program Files/Git/bin/bash.exe');
    it.skipIf(!available)(
      `${shell}: backs up before pull, migrates before health, and rolls back a failed migration`,
      async () => {
        const f = await fixture(`${shell}-migration`),
          result = await f.run(shell, ['update', 'release.json'], 'migration');
        expect(result.code, result.output).toBe(1);
        const calls = (await readFile(f.log, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[]);
        const index = (word: string) => calls.findIndex((args) => args.includes(word));
        expect(index('update-prepare')).toBeLessThan(index('pull'));
        expect(index('migrating')).toBeLessThan(index('rollback'));
        expect(index('rollback')).toBeLessThan(index('finish-rollback'));
        expect(index('update-activate')).toBe(-1);
        expect(await readFile(f.state, 'utf8')).toBe('rolled-back');
        expect(await readFile(join(f.root, 'data/compose.release.yaml'), 'utf8')).toContain(
          `sha256:${'b'.repeat(64)}`,
        );
      },
    );
    it.skipIf(!available)(
      `${shell}: automatically restores on health failure and preserves an uncertain activation`,
      async () => {
        const f = await fixture(`${shell}-health`),
          failed = await f.run(shell, ['update', 'release.json'], 'health');
        expect(failed.code, failed.output).toBe(1);
        expect(await readFile(f.state, 'utf8')).toBe('rolled-back');
        const uncertain = await f.run(shell, ['update', 'release.json'], 'activation');
        expect(uncertain.code, uncertain.output).toBe(1);
        expect(await readFile(f.state, 'utf8')).toBe('activation-intent');
        const previous = await readFile(join(f.root, 'data/compose.update.previous.yaml'), 'utf8');
        expect((await f.run(shell, ['update', 'release.json'])).code).toBe(1);
        expect(await readFile(join(f.root, 'data/compose.update.previous.yaml'), 'utf8')).toBe(
          previous,
        );
        const recovered = await f.run(shell, ['update', 'recover']);
        expect(recovered.code, recovered.output).toBe(0);
        expect(await readFile(f.state, 'utf8')).toBe('done');
        expect(await readFile(join(f.root, 'data/compose.release.yaml'), 'utf8')).toContain(
          `@sha256:${'a'.repeat(64)}`,
        );
      },
    );
    it.skipIf(!available)(
      `${shell}: preserves arbitrary ciphertext bytes in both transfer directions`,
      async () => {
        const f = await fixture(`${shell}-binary`),
          file = 'backup $literal.sazuz';
        const result = await f.run(shell, ['backup', file]);
        expect(result.code, result.output).toBe(0);
        const bytes = await readFile(join(f.root, file));
        expect(bytes.length).toBe(70000);
        expect([...bytes.subarray(252, 258)]).toEqual([252, 253, 254, 255, 0, 1]);
        const restored = await f.run(shell, ['restore', file]);
        expect(restored.code, restored.output).toBe(0);
        expect(await readFile(f.log, 'utf8')).toContain(
          createHash('sha256').update(bytes).digest('hex'),
        );
        expect((await f.run(shell, ['backup', file])).code).toBe(1);
      },
    );
    it.skipIf(!available)(
      `${shell}: preserves bundled service pins before an activated core override`,
      async () => {
        const f = await fixture(`${shell}-bundled`);
        await writeFile(join(f.root, 'deploy/compose.release.yaml'), 'services: {}\n');
        await writeFile(join(f.root, 'data/compose.release.yaml'), 'services: {}\n');
        const result = await f.run(shell, ['backup', 'bundled.sazuz']);
        expect(result.code, result.output).toBe(0);
        const calls = (await readFile(f.log, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[]);
        const command = calls.find((args) => args.includes('backup'))!;
        const paths = command.map((value) => value.replaceAll('\\', '/'));
        expect(
          paths.findIndex((value) => value.endsWith('/deploy/compose.release.yaml')),
        ).toBeGreaterThan(-1);
        expect(
          paths.findIndex((value) => value.endsWith('/deploy/compose.release.yaml')),
        ).toBeLessThan(paths.findIndex((value) => value.endsWith('/data/compose.release.yaml')));
      },
    );
  }
});
