import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { publicDocumentation } from './docs-pages.js';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    if (resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('sazuz-docs-archive-'))
      await rm(root, { recursive: true, force: true });
});

it('ships the landing page and reviewed assets while excluding private documentation from a real Git archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sazuz-docs-archive-'));
  roots.push(root);
  const publicFiles = [
    'package.json',
    'install.sh',
    'deploy/compose.yaml',
    'apps/server/src/app.ts',
    'skills/morning-brief/SKILL.md',
    'apps/web/public/fonts/OFL.txt',
    'README.md',
    'LICENSE',
    'docs/reference.md',
    'docs/screenshots/README.md',
    'docs/screenshots/workspace-light.png',
  ];
  const privateFiles = [
    ...publicDocumentation.map((page) => page.source),
    'docs/site.css',
    'docs/README.md',
    'docs/report.md',
    'docs/packages/runtime/README.md',
    'plan.md',
    'agents.md',
    'sazuz-build-prompt.md',
    'future-internal-prompt.md',
    'apps/web/AGENTS.md',
    'docs/PLAN.md',
    'docs/PROGRESS.md',
    'docs/DECISIONS.md',
    'docs/security-review.md',
    'docs/demo.md',
    'docs/future-report.md',
    'docs/future-report.json',
    'docs/phases/phase-11.md',
    'docs/phases/phase-11-report.md',
    'docs/phases/phase-11-evidence.json',
    'docs/phases/phase-10-comparison.html',
    'docs/phases/assets/private.webm',
    'docs/releases/unreviewed.md',
    'docs/releases/unreviewed.json',
  ];
  for (const file of [...publicFiles, ...privateFiles]) {
    await mkdir(join(root, dirname(file)), { recursive: true });
    await writeFile(
      join(root, file),
      privateFiles.includes(file) ? 'PRIVATE_ARCHIVE_CANARY\n' : 'PUBLIC_SOURCE_CANARY\n',
    );
  }
  await writeFile(join(root, '.gitattributes'), await readFile(resolve('.gitattributes')));
  await writeFile(join(root, '.gitignore'), await readFile(resolve('.gitignore')));
  const run = (program: string, args: string[]) =>
    execute(program, args, { cwd: root, windowsHide: true });
  await run('git', ['init', '--quiet']);
  const { stdout: ignored } = await run('git', [
    'check-ignore',
    '--no-index',
    ...publicFiles,
    ...privateFiles.filter((file) => file.startsWith('docs/')),
  ]);
  const ignoredPaths = ignored.trim().split(/\r?\n/);
  for (const file of publicFiles) expect(ignoredPaths).not.toContain(file);
  for (const file of privateFiles.filter((file) => file.startsWith('docs/')))
    expect(ignoredPaths).toContain(file);
  // Include private files in this temporary tree to test archive filtering itself.
  await run('git', ['add', '--force', '.']);
  // A tree exercises committed attributes without creating a commit or touching this repo's index.
  const { stdout: tree } = await run('git', ['write-tree']);
  const archive = join(root, 'source.tar');
  await run('git', ['archive', '--format=tar', '--output', archive, tree.trim()]);
  const { stdout: listing } = await run('tar', ['-tf', archive]);
  const entries = listing.trim().split(/\r?\n/);
  for (const file of publicFiles) expect(entries).toContain(file);
  for (const file of privateFiles) expect(entries).not.toContain(file);
  expect((await readFile(archive)).includes(Buffer.from('PRIVATE_ARCHIVE_CANARY'))).toBe(false);
  expect((await readFile(archive)).includes(Buffer.from('PUBLIC_SOURCE_CANARY'))).toBe(true);
});
