import { and, desc, eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  defaultSettings,
  freshSettings,
  namespaceSchema,
  parseSetting,
  settingsDocumentSchema,
  type SettingsDocument,
  type SettingsNamespace,
  type SettingsValues,
} from '@sazuz/config/settings';
import { SazuzError } from '@sazuz/core';
import { secretRedactor } from '@sazuz/vault';
import { z } from 'zod';
import type { Database } from './client.js';
import { auditLog, settings, settingsHistory } from './schema.js';
import type { Transaction } from './missions.js';

export class SettingsError extends SazuzError {
  constructor(code: 'SETTINGS_INVALID' | 'SETTINGS_CONFLICT' | 'SETTINGS_HISTORY_NOT_FOUND') {
    super(
      code,
      {
        SETTINGS_INVALID: 'The settings are invalid. Use the vault for credentials.',
        SETTINGS_CONFLICT: 'These settings changed elsewhere. Reload and try again.',
        SETTINGS_HISTORY_NOT_FOUND: 'That settings revision does not exist.',
      }[code],
    );
  }
}

function validate<N extends SettingsNamespace>(namespace: N, value: unknown): SettingsValues[N] {
  const result = namespaceSchema.safeParse(namespace);
  if (!result.success) throw new SettingsError('SETTINGS_INVALID');
  let parsed: SettingsValues[N];
  try {
    parsed = parseSetting(namespace, value);
  } catch {
    throw new SettingsError('SETTINGS_INVALID');
  }
  // Scan scalar values rather than object field names: secretRef handles are intentionally public.
  const scan = (entry: unknown): boolean =>
    typeof entry === 'string'
      ? secretRedactor.redactText(entry) === entry
      : Array.isArray(entry)
        ? entry.every(scan)
        : entry !== null && typeof entry === 'object'
          ? Object.values(entry).every(scan)
          : true;
  if (!scan(parsed)) throw new SettingsError('SETTINGS_INVALID');
  return parsed;
}

export async function readSettings(database: Database): Promise<SettingsDocument> {
  const document = freshSettings();
  for (const row of await database.orm.select().from(settings)) {
    const namespace = namespaceSchema.parse(row.namespace);
    Object.assign(document, {
      [namespace]: { version: row.version, value: parseSetting(namespace, row.value) },
    });
  }
  return settingsDocumentSchema.parse(document);
}

export async function initializeSettings(database: Database, baseUrl: string): Promise<void> {
  for (const namespace of namespaceSchema.options) {
    const value =
      namespace === 'general'
        ? { ...defaultSettings.general, baseUrl }
        : defaultSettings[namespace];
    await database.orm.transaction(async (tx) => {
      const rows = await tx
        .insert(settings)
        .values({ namespace, value: parseSetting(namespace, value), version: 1 })
        .onConflictDoNothing()
        .returning();
      if (rows.length) {
        await tx
          .insert(settingsHistory)
          .values({ namespace, version: 1, value, actorId: 'bootstrap' });
        await tx.execute(sql`SELECT pg_notify('settings_changed', ${namespace})`);
      }
    });
  }
}

export async function saveSetting<N extends SettingsNamespace>(
  database: Database,
  input: { namespace: N; value: unknown; expectedVersion: number; actorId: string },
) {
  return database.orm.transaction((tx) => saveSettingIn(tx, input));
}
export async function saveSettingIn<N extends SettingsNamespace>(
  tx: Transaction,
  input: { namespace: N; value: unknown; expectedVersion: number; actorId: string },
) {
  const value = validate(input.namespace, input.value);
  if (!z.number().int().nonnegative().safeParse(input.expectedVersion).success)
    throw new SettingsError('SETTINGS_INVALID');
  const nextVersion = input.expectedVersion + 1;
  const changed =
    input.expectedVersion === 0
      ? await tx
          .insert(settings)
          .values({ namespace: input.namespace, value, version: 1 })
          .onConflictDoNothing()
          .returning()
      : await tx
          .update(settings)
          .set({ value, version: nextVersion, updatedAt: new Date() })
          .where(
            and(
              eq(settings.namespace, input.namespace),
              eq(settings.version, input.expectedVersion),
            ),
          )
          .returning();
  if (changed.length !== 1) throw new SettingsError('SETTINGS_CONFLICT');
  await tx
    .insert(settingsHistory)
    .values({ namespace: input.namespace, version: nextVersion, value, actorId: input.actorId });
  await tx.insert(auditLog).values({
    id: `aud_${ulid()}`,
    actorId: input.actorId,
    action: 'settings.changed',
    target: `${input.namespace}:${nextVersion}`,
  });
  await tx.execute(sql`SELECT pg_notify('settings_changed', ${input.namespace})`);
  return { namespace: input.namespace, value, version: nextVersion };
}

export async function readSettingsHistory(database: Database, namespace: SettingsNamespace) {
  const rows = await database.orm
    .select()
    .from(settingsHistory)
    .where(eq(settingsHistory.namespace, namespace))
    .orderBy(desc(settingsHistory.version))
    .limit(50);
  return rows.map((row) => ({
    version: row.version,
    value: parseSetting(namespace, row.value),
    changedAt: row.changedAt.toISOString(),
    actorId: row.actorId,
  }));
}

export async function rollbackSetting(
  database: Database,
  namespace: SettingsNamespace,
  version: number,
  expectedVersion: number,
  actorId: string,
) {
  const rows = await database.orm
    .select()
    .from(settingsHistory)
    .where(and(eq(settingsHistory.namespace, namespace), eq(settingsHistory.version, version)))
    .limit(1);
  if (!rows[0]) throw new SettingsError('SETTINGS_HISTORY_NOT_FOUND');
  return saveSetting(database, { namespace, value: rows[0].value, expectedVersion, actorId });
}
