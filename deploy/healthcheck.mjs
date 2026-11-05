import { pathToFileURL } from 'node:url';

import { z } from 'zod';

const portSchema = z.number().int().min(1).max(65_535);
const readySchema = z.object({
  status: z.literal('ok'),
  services: z.object({
    database: z.object({ status: z.literal('ok') }),
    worker: z.object({ status: z.literal('ok'), activeCount: z.number().int().positive() }),
  }),
});

/** @param {number} port @returns {Promise<boolean>} */
export async function checkHealth(port) {
  if (!portSchema.safeParse(port).success) return false;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(3_000),
    });
    return response.status === 200 && readySchema.safeParse(await response.json()).success;
  } catch {
    // Transport and parse failures are a negative readiness result. The CLI
    // reports only the safe status, because Docker retains its output.
    return false;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const role = z.enum(['server', 'web']).safeParse(process.argv[2]);
  const ready =
    role.success &&
    process.argv.length === 3 &&
    (await checkHealth(role.data === 'server' ? 7778 : 7777));

  if (!ready) {
    process.stderr.write('Sazuz health check failed.\n');
    process.exitCode = 1;
  }
}
