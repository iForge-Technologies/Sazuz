import { z } from 'zod';

export const databaseHealthSchema = z.strictObject({
  status: z.enum(['ok', 'error']),
  latencyMs: z.number().nonnegative(),
});

export const workerHealthSchema = z
  .strictObject({
    status: z.enum(['ok', 'missing', 'stale', 'unavailable']),
    activeCount: z.number().int().nonnegative(),
    lastSeenAt: z.iso.datetime().nullable(),
  })
  .refine((value) => (value.status === 'ok' ? value.activeCount > 0 : value.activeCount === 0), {
    message: 'Worker status must agree with its active count.',
  });

export const healthSchema = z
  .strictObject({
    status: z.enum(['ok', 'degraded']),
    checkedAt: z.iso.datetime(),
    services: z.strictObject({ database: databaseHealthSchema, worker: workerHealthSchema }),
  })
  .refine(
    (value) =>
      (value.status === 'ok') ===
      (value.services.database.status === 'ok' && value.services.worker.status === 'ok'),
    {
      message: 'Overall health must agree with its services.',
    },
  );

export type Health = z.infer<typeof healthSchema>;
export type WorkerHealth = z.infer<typeof workerHealthSchema>;
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TTL_MS = 15_000;
