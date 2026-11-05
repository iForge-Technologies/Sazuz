import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { OperationsError } from '@sazuz/core/operations';
import { MIGRATION_LOCK, type Database } from '@sazuz/db';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const migrationIdentitySchema = z.strictObject({
  count: z.number().int().min(1).max(10000),
  sha256,
});
export type MigrationIdentity = z.infer<typeof migrationIdentitySchema>;
const journalSchema = z.strictObject({
  version: z.literal('7'),
  dialect: z.literal('postgresql'),
  entries: z
    .array(
      z.strictObject({
        idx: z.number().int().nonnegative(),
        version: z.literal('7'),
        when: z.number().int().positive().safe(),
        tag: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/)
          .max(128),
        breakpoints: z.boolean(),
      }),
    )
    .min(1)
    .max(10000),
});
type InstalledMigrations = {
  identity: MigrationIdentity;
  history: { hash: string; when: string }[];
};

export async function installedMigrations(
  directory = resolve(process.cwd(), 'packages/db/migrations'),
): Promise<InstalledMigrations> {
  try {
    const journal = journalSchema.parse(
      JSON.parse(await readFile(join(directory, 'meta/_journal.json'), 'utf8')),
    );
    const entries = [];
    const tags = new Set<string>();
    let previous = 0;
    for (const [index, entry] of journal.entries.entries()) {
      if (entry.idx !== index || tags.has(entry.tag) || entry.when <= previous)
        throw new OperationsError('OPS_MIGRATIONS');
      previous = entry.when;
      tags.add(entry.tag);
      // Match Drizzle's hash of the UTF-8 SQL exactly. Releases preserve LF bytes.
      const sql = await readFile(join(directory, `${entry.tag}.sql`), 'utf8');
      entries.push({
        idx: entry.idx,
        tag: entry.tag,
        when: entry.when,
        hash: createHash('sha256').update(sql).digest('hex'),
      });
    }
    return {
      identity: {
        count: entries.length,
        sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
      },
      history: entries.map((entry) => ({ hash: entry.hash, when: String(entry.when) })),
    };
  } catch {
    throw new OperationsError('OPS_MIGRATIONS');
  }
}

export function requireMigrationHistory(installed: InstalledMigrations, raw: unknown) {
  const parsed = z
    .array(z.strictObject({ hash: sha256, when: z.string().regex(/^\d+$/) }))
    .safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.length !== installed.history.length ||
    parsed.data.some(
      (entry, i) =>
        entry.hash !== installed.history[i]?.hash || entry.when !== installed.history[i]?.when,
    )
  )
    throw new OperationsError('OPS_MIGRATIONS');
}

/** Hold the migrator's shared lock through the dump, preventing mixed-release snapshots. */
export async function withSnapshotMigrations<T>(
  database: Database,
  capture: (identity: MigrationIdentity) => Promise<T>,
) {
  const connection = await database.pool.connect();
  let broken = false;
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock_shared($1)', [MIGRATION_LOCK]);
    const installed = await installedMigrations();
    const history = await connection.query(
      'SELECT hash, created_at::text AS "when" FROM drizzle.__drizzle_migrations ORDER BY id',
    );
    requireMigrationHistory(installed, history.rows);
    const result = await capture(installed.identity);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await connection.query('ROLLBACK');
    } catch {
      broken = true;
      database.logger.warn(
        { code: 'SNAPSHOT_MIGRATION_CONNECTION_LOST' },
        'Snapshot migration lock connection closed.',
      );
    }
    throw error;
  } finally {
    connection.release(broken);
  }
}

export async function requireRestoreMigrations(identity: MigrationIdentity, directory?: string) {
  const installed = (await installedMigrations(directory)).identity;
  if (identity.count !== installed.count || identity.sha256 !== installed.sha256)
    throw new OperationsError('OPS_RESTORE_VERSION');
}
