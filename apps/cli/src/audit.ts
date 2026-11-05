import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { auditBundleSchema } from '@sazuz/core/audit';
import { verifyAuditBundle } from '@sazuz/core/audit-verify';

const argsSchema = z.union([
  z.tuple([z.literal('verify'), z.string().min(1).max(4096)]),
  z.tuple([
    z.literal('verify'),
    z.string().min(1).max(4096),
    z.literal('--head'),
    z.string().regex(/^\d+:[a-f0-9]{64}$/),
  ]),
]);
export async function runAuditCli(args: string[], output: (message: string) => void) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success)
    throw new Error('Usage: sazuz audit verify export.json [--head sequence:hash]');
  const input = parsed.data;
  const size = await stat(input[1]);
  if (!size.isFile() || size.size > 32 * 1024 * 1024)
    throw new Error('Audit export exceeds the file limit.');
  const bundle = auditBundleSchema.parse(JSON.parse(await readFile(input[1], 'utf8')));
  const anchor = input[3]?.split(':');
  const expected = anchor ? { sequence: Number(anchor[0]), hash: anchor[1]! } : undefined;
  if (!verifyAuditBundle(bundle, expected))
    throw new Error('Audit integrity verification failed. Preserve the export and trusted head.');
  output(
    `Verified ${bundle.head.sequence} entries. Head: ${bundle.head.sequence}:${bundle.head.hash}`,
  );
  if (!expected) output('Compare this head with a copy retained outside the instance.');
}
