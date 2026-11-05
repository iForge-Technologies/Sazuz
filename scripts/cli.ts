import { runCli } from '../apps/cli/src/commands.js';
try {
  await runCli(process.argv.slice(2));
} catch {
  process.stderr.write(
    'Sazuz command failed. Check the command, local server, and entered credentials.\n',
  );
  process.exitCode = 1;
}
