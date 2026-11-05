import { and, eq } from 'drizzle-orm';
import {
  storedSecretSchema,
  vaultMetadataSchema,
  type StoredSecret,
  type VaultRepository,
} from '@sazuz/vault';
import type { Database } from './client.js';
import { secrets, vaultMeta } from './schema.js';

const toRow = (value: StoredSecret) => ({
  ...value,
  ciphertext: value.envelope.ciphertext,
  nonce: value.envelope.nonce,
  envelopeVersion: value.envelope.version,
  createdAt: new Date(value.createdAt),
  updatedAt: new Date(value.updatedAt),
});
const fromRow = (row: typeof secrets.$inferSelect): StoredSecret =>
  storedSecretSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    purpose: row.purpose,
    name: row.name,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revision: row.revision,
    maskedValue: row.maskedValue,
    envelope: { version: row.envelopeVersion, nonce: row.nonce, ciphertext: row.ciphertext },
  });
export function vaultRepository(database: Database): VaultRepository {
  return {
    async readMetadata() {
      const [row] = await database.orm.select().from(vaultMeta).limit(1);
      return row ? vaultMetadataSchema.parse(row.value) : null;
    },
    async writeMetadata(next, expectedRevision) {
      const value = vaultMetadataSchema.parse(next);
      const rows =
        expectedRevision === null
          ? await database.orm
              .insert(vaultMeta)
              .values({ revision: value.revision, value })
              .onConflictDoNothing()
              .returning()
          : await database.orm
              .update(vaultMeta)
              .set({ revision: value.revision, value })
              .where(eq(vaultMeta.revision, expectedRevision))
              .returning();
      return rows.length === 1;
    },
    async insertSecret(row) {
      return (
        (
          await database.orm
            .insert(secrets)
            .values(toRow(storedSecretSchema.parse(row)))
            .onConflictDoNothing()
            .returning()
        ).length === 1
      );
    },
    async readSecret(id) {
      const [row] = await database.orm.select().from(secrets).where(eq(secrets.id, id));
      return row ? fromRow(row) : null;
    },
    async listSecrets(workspaceId) {
      return (
        await database.orm.select().from(secrets).where(eq(secrets.workspaceId, workspaceId))
      ).map(fromRow);
    },
    async updateSecret(row, expectedRevision) {
      return (
        (
          await database.orm
            .update(secrets)
            .set(toRow(storedSecretSchema.parse(row)))
            .where(
              and(
                eq(secrets.id, row.id),
                eq(secrets.workspaceId, row.workspaceId),
                eq(secrets.revision, expectedRevision),
              ),
            )
            .returning()
        ).length === 1
      );
    },
    async deleteSecret(id, workspaceId) {
      return (
        (
          await database.orm
            .delete(secrets)
            .where(and(eq(secrets.id, id), eq(secrets.workspaceId, workspaceId)))
            .returning()
        ).length === 1
      );
    },
  };
}
