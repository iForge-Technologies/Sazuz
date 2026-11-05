import { z } from 'zod';
import { workId } from './work';

export const sandboxInputSchema = z.strictObject({
  language: z.enum(['python', 'node']),
  code: z.string().min(1).max(32_768),
  network: z.enum(['none', 'allowlist']).default('none'),
});
export type SandboxInput = z.infer<typeof sandboxInputSchema>;
export const sandboxResultSchema = z.strictObject({
  executionId: workId,
  exitCode: z.number().int().min(-1).max(255),
  output: z.string().max(65_536),
  truncated: z.boolean(),
  timedOut: z.boolean(),
});
export type SandboxResult = z.infer<typeof sandboxResultSchema>;
export const sandboxExecutionSchema = z.strictObject({
  id: workId,
  runId: workId,
  projectId: workId,
  agentId: z.string().max(128),
  language: z.enum(['python', 'node']),
  network: z.enum(['none', 'allowlist']),
  status: z.enum(['creating', 'running', 'done', 'uncertain']),
  result: sandboxResultSchema.nullable(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export const sandboxDiagnosticsSchema = z.strictObject({
  docker: z.enum(['ready', 'unavailable']),
  egress: z.enum(['ready', 'unavailable']),
  browser: z.enum(['ready', 'unavailable']).default('unavailable'),
  platform: z.string().max(32),
  memoryMb: z.number().int().nonnegative(),
  freeDiskMb: z.number().int().nonnegative().nullable(),
  gpu: z.literal('unknown'),
  hint: z.string().max(1000),
});

export class SandboxError extends Error {
  constructor(
    readonly code:
      | 'SANDBOX_INVALID'
      | 'SANDBOX_UNAVAILABLE'
      | 'SANDBOX_DENIED'
      | 'SANDBOX_UNCERTAIN'
      | 'SANDBOX_CONFLICT',
  ) {
    super(
      {
        SANDBOX_INVALID: 'The sandbox request is invalid.',
        SANDBOX_UNAVAILABLE:
          'The sandbox infrastructure is unavailable. Check Docker, the proxies and sandbox images.',
        SANDBOX_DENIED: 'The sandbox request is outside its execution permissions.',
        SANDBOX_UNCERTAIN:
          'The execution outcome is uncertain and must be reviewed before retrying.',
        SANDBOX_CONFLICT: 'The sandbox execution changed. Reload before continuing.',
      }[code],
    );
    this.name = 'SandboxError';
  }
}
