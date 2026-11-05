import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const executable = fileURLToPath(new URL('../node_modules/eslint/bin/eslint.js', import.meta.url));

async function lint(paths: string[], extra: string[] = []): Promise<void> {
  // Release TypeScript's project graphs between workspaces as the monorepo grows.
  // Every directory and the root still use the same typed rules and warning limit.
  process.stdout.write(`Linting ${paths.join(', ')}\n`);
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=6144', executable, ...paths, '--max-warnings=0', ...extra],
      { cwd: root, stdio: 'inherit', windowsHide: true },
    );
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) throw new Error('ESLint failed; see diagnostics above.');
}

try {
  await lint(['.'], ['--ignore-pattern', 'apps/**', '--ignore-pattern', 'packages/**']);
  for (const parent of ['apps', 'packages']) {
    const entries = await readdir(new URL(`../${parent}/`, import.meta.url), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory())
        await lint([`${parent}/${entry.name}`], ['--no-error-on-unmatched-pattern']);
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Could not run ESLint.'}\n`);
  process.exitCode = 1;
}
