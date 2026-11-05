import { and, desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  BrowserError,
  browserProfileInputSchema,
  browserProfileSchema,
  browserProfileUpdateSchema,
  browserSessionSchema,
} from '@sazuz/core/browser';
import {
  auditLog,
  browserProfiles,
  browserSessions,
  projects,
  workKey,
  type Database,
} from '@sazuz/db';
import { secretRedactor, type Vault, type SecretReference } from '@sazuz/vault';
import { browserProfileStateSchema, scopedStorage } from './protocol.js';

export function publicBrowserProfile(row: typeof browserProfiles.$inferSelect) {
  return browserProfileSchema.parse({
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    name: row.name,
    site: row.site,
    secretRefs: row.secretRefs,
    version: row.version,
    retired: row.retired,
    hasSavedState: row.vaultRef !== null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}
export function publicBrowserSession(row: typeof browserSessions.$inferSelect) {
  return browserSessionSchema.parse({
    id: row.id,
    profileId: row.profileId,
    runId: row.runId,
    projectId: row.projectId,
    agentId: row.agentId,
    status: row.status,
    control: row.control,
    version: row.version,
    sensitive: row.sensitive,
    challenge: row.challenge,
    origin: row.origin,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });
}
export function createBrowserProfiles(database: Database, vault: Vault) {
  async function owned(userId: string, id: string) {
    const [row] = await database.orm
      .select()
      .from(browserProfiles)
      .where(and(eq(browserProfiles.id, id), eq(browserProfiles.userId, userId)));
    if (!row) throw new BrowserError('BROWSER_DENIED');
    return row;
  }
  async function validate(
    userId: string,
    input: z.infer<typeof browserProfileInputSchema> | z.infer<typeof browserProfileUpdateSchema>,
  ) {
    if (secretRedactor.redactText(input.name) !== input.name)
      throw new BrowserError('BROWSER_INVALID');
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now())
      throw new BrowserError('BROWSER_INVALID');
    const secrets = await vault.list();
    if (
      input.secretRefs.some(
        (ref) => !secrets.some((secret) => secret.reference === ref && secret.createdBy === userId),
      )
    )
      throw new BrowserError('BROWSER_DENIED');
  }
  async function revoke(userId: string, id: string, version: number, retired: boolean) {
    let reference: string | null = null;
    await database.orm.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(browserProfiles)
        .where(and(eq(browserProfiles.id, id), eq(browserProfiles.userId, userId)))
        .for('update');
      if (!row || row.version !== version) throw new BrowserError('BROWSER_CONFLICT');
      reference = row.vaultRef;
      await tx
        .update(browserProfiles)
        .set({
          vaultRef: null,
          retired,
          secretRefs: retired ? [] : row.secretRefs,
          version: row.version + 1,
          generation: row.generation + 1,
          updatedAt: new Date(),
        })
        .where(eq(browserProfiles.id, id));
      await tx
        .update(browserSessions)
        .set({
          status: 'closed',
          control: 'human',
          version: sql`${browserSessions.version}+1`,
          updatedAt: new Date(),
        })
        .where(eq(browserSessions.profileId, id));
      await tx.insert(auditLog).values({
        id: workKey('aud'),
        actorId: userId,
        action: retired ? 'browser.profile.wipe' : 'browser.profile.sign_out',
        target: id,
      });
    });
    if (reference)
      await vault.delete((reference as string).slice('secret://'.length), 'browser-profiles');
    return publicBrowserProfile(await owned(userId, id));
  }
  return {
    owned,
    async list(userId: string) {
      return (
        await database.orm
          .select()
          .from(browserProfiles)
          .where(eq(browserProfiles.userId, userId))
          .orderBy(desc(browserProfiles.createdAt))
          .limit(100)
      ).map(publicBrowserProfile);
    },
    async sessions(userId: string) {
      return (
        await database.orm
          .select({ session: browserSessions })
          .from(browserSessions)
          .innerJoin(browserProfiles, eq(browserProfiles.id, browserSessions.profileId))
          .where(eq(browserProfiles.userId, userId))
          .orderBy(desc(browserSessions.createdAt))
          .limit(100)
      ).map(({ session }) => publicBrowserSession(session));
    },
    async create(userId: string, input: unknown) {
      const parsed = browserProfileInputSchema.parse(input);
      await validate(userId, parsed);
      const [project] = await database.orm
        .select()
        .from(projects)
        .where(and(eq(projects.id, parsed.projectId), eq(projects.userId, userId)));
      if (!project) throw new BrowserError('BROWSER_DENIED');
      const count = await database.orm
        .select({ id: browserProfiles.id })
        .from(browserProfiles)
        .where(and(eq(browserProfiles.userId, userId), eq(browserProfiles.retired, false)))
        .limit(101);
      if (count.length >= 100) throw new BrowserError('BROWSER_DENIED');
      return database.orm.transaction(async (tx) => {
        const [row] = await tx
          .insert(browserProfiles)
          .values({
            ...parsed,
            id: workKey('bpr'),
            userId,
            expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
          })
          .returning();
        await tx.insert(auditLog).values({
          id: workKey('aud'),
          actorId: userId,
          action: 'browser.profile.create',
          target: row!.id,
        });
        return publicBrowserProfile(row!);
      });
    },
    async update(userId: string, id: string, input: unknown) {
      const parsed = browserProfileUpdateSchema.parse(input);
      await validate(userId, parsed);
      return database.orm.transaction(async (tx) => {
        const [row] = await tx
          .update(browserProfiles)
          .set({
            name: parsed.name,
            secretRefs: parsed.secretRefs,
            expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
            version: parsed.version + 1,
            generation: sql`${browserProfiles.generation}+1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(browserProfiles.id, id),
              eq(browserProfiles.userId, userId),
              eq(browserProfiles.version, parsed.version),
              eq(browserProfiles.retired, false),
            ),
          )
          .returning();
        if (!row) throw new BrowserError('BROWSER_CONFLICT');
        await tx
          .update(browserSessions)
          .set({
            status: 'closed',
            control: 'human',
            version: sql`${browserSessions.version}+1`,
            updatedAt: new Date(),
          })
          .where(eq(browserSessions.profileId, id));
        await tx.insert(auditLog).values({
          id: workKey('aud'),
          actorId: userId,
          action: 'browser.profile.update',
          target: id,
        });
        return publicBrowserProfile(row);
      });
    },
    revoke,
    async save(id: string, generation: number, value: string) {
      const state = browserProfileStateSchema.parse(JSON.parse(value));
      let previous: string | null = null;
      await database.orm.transaction(async (tx) => {
        const [profile] = await tx
          .select()
          .from(browserProfiles)
          .where(eq(browserProfiles.id, id))
          .for('update');
        if (
          !profile ||
          profile.retired ||
          profile.generation !== generation ||
          (profile.expiresAt && profile.expiresAt.getTime() <= Date.now())
        )
          throw new BrowserError('BROWSER_DENIED');
        scopedStorage(state.state, profile.site);
        if (Buffer.byteLength(value) > 60000) throw new BrowserError('BROWSER_INVALID');
        const saved = await vault.create(
          {
            name: `Browser ${profile.id}`,
            value: JSON.stringify(state),
            createdBy: profile.userId,
          },
          'browser-profiles',
        );
        previous = profile.vaultRef;
        await tx
          .update(browserProfiles)
          .set({ vaultRef: saved.reference, updatedAt: new Date() })
          .where(eq(browserProfiles.id, id));
      });
      if (previous)
        await vault.delete((previous as string).slice('secret://'.length), 'browser-profiles');
    },
    async state<T>(
      profile: typeof browserProfiles.$inferSelect,
      consume: (value: string) => Promise<T>,
    ) {
      return profile.vaultRef
        ? vault.withSecret(profile.vaultRef as SecretReference, 'browser-profiles', consume)
        : consume(JSON.stringify({ state: { cookies: [], origins: [] }, redactions: [] }));
    },
  };
}
