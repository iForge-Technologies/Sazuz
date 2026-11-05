import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLog,
  exportAudit,
  passkeys,
  securityRateLimits,
  sessions,
  users,
  workKey,
  workspaceMemberships,
} from '@sazuz/db';
import {
  auditExportSchema,
  passkeyAuthenticateOptionsSchema,
  passkeyListSchema,
  passkeyRegisterOptionsSchema,
} from '@sazuz/core/audit';
import { verifyAuditBundle, verifyAuditExport } from '@sazuz/core/audit-verify';
import { registerPhaseEleven } from '../../apps/server/src/phase-eleven.js';
import { phaseFourFixture } from './phase-four-fixture.js';
import { authenticatorFixture } from './phase-eleven-authenticator.js';

describe('Phase 11 identity and audit against PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof phaseFourFixture>>;
  beforeAll(async () => {
    f = await phaseFourFixture(registerPhaseEleven);
  });
  beforeEach(async () => {
    await f.db.orm.delete(securityRateLimits);
  });
  afterAll(async () => {
    await f?.close();
  });
  async function register(key = authenticatorFixture()) {
    const options = await f.request('POST', '/api/passkeys/register-options', {});
    expect(options.statusCode, options.body).toBe(200);
    const body = key.register(passkeyRegisterOptionsSchema.parse(options.json<unknown>()));
    const result = await f.request('POST', '/api/passkeys/register', body);
    expect(result.statusCode, result.body).toBe(200);
    return { key, body };
  }
  it('backfills owner membership and preserves the owner boundary', async () => {
    const membership = await f.db.orm.select().from(workspaceMemberships);
    expect(membership).toHaveLength(1);
    expect(membership[0]).toMatchObject({ userId: f.userId, role: 'owner' });
    expect((await f.request('GET', '/api/operations/identity')).statusCode).toBe(200);
    expect((await f.request('GET', '/api/audit', undefined, false)).statusCode).toBe(401);
    expect((await f.request('GET', '/api/passkeys', undefined, false)).statusCode).toBe(401);
    expect((await f.request('POST', '/api/passkeys/register-options', {}, false)).statusCode).toBe(
      401,
    );
    expect(
      (
        await f.request(
          'POST',
          '/api/passkeys/authenticate-options',
          {},
          false,
          'https://evil.example',
        )
      ).statusCode,
    ).toBe(403);
  });
  it('registers a real ES256 credential, authenticates, consumes the challenge and never returns a session token', async () => {
    const { key, body } = await register();
    expect((await f.request('POST', '/api/passkeys/register', body)).statusCode).toBe(400);
    const start = await f.request('POST', '/api/passkeys/authenticate-options', {});
    expect(start.statusCode, start.body).toBe(200);
    const assertion = key.authenticate(
      passkeyAuthenticateOptionsSchema.parse(start.json<unknown>()),
    );
    const result = await f.request('POST', '/api/passkeys/authenticate', assertion);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json<unknown>()).toEqual({ ok: true });
    expect(result.cookies.some((cookie) => cookie.name.includes('session_token'))).toBe(true);
    expect((await f.request('POST', '/api/passkeys/authenticate', assertion)).statusCode).toBe(400);
    const list = await f.request('GET', '/api/passkeys');
    expect(list.body).not.toMatch(/publicKey|credentialID|token/);
    const saved = passkeyListSchema.parse(list.json<unknown>());
    const row = (await f.db.orm.select().from(passkeys).where(eq(passkeys.id, saved[0]!.id)))[0]!;
    expect(row.counter).toBe(1);
    const chain = await exportAudit(f.db, 0, 1000);
    expect(chain.entries.some((entry) => entry.payload[2] === 'passkey.registered')).toBe(true);
    expect(chain.entries.some((entry) => entry.payload[2] === 'passkey.authenticated')).toBe(true);
  });
  it('rejects enrollment without device verification and rejects signed assertions for another origin or without verification', async () => {
    const unverified = authenticatorFixture();
    const options = await f.request('POST', '/api/passkeys/register-options', {});
    const rejected = await f.request(
      'POST',
      '/api/passkeys/register',
      unverified.register(passkeyRegisterOptionsSchema.parse(options.json<unknown>()), false),
    );
    expect(rejected.statusCode, rejected.body).toBe(400);
    const { key } = await register();
    const start = () => f.request('POST', '/api/passkeys/authenticate-options', {});
    const first = passkeyAuthenticateOptionsSchema.parse((await start()).json<unknown>());
    expect(
      (await f.request('POST', '/api/passkeys/authenticate', key.authenticate(first, false)))
        .statusCode,
    ).toBe(400);
    const second = passkeyAuthenticateOptionsSchema.parse((await start()).json<unknown>());
    expect(
      (
        await f.request(
          'POST',
          '/api/passkeys/authenticate',
          key.authenticate(second, true, 'https://evil.example'),
        )
      ).statusCode,
    ).toBe(400);
  });
  it('validates credentials and bounds anonymous challenge requests', async () => {
    expect(
      (await f.request('POST', '/api/passkeys/authenticate', { response: { unexpected: true } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await f.request('POST', '/api/passkeys/authenticate-options', {
          origin: 'https://evil.example',
        })
      ).statusCode,
    ).toBe(400);
    for (let i = 0; i < 10; i++)
      expect((await f.request('POST', '/api/passkeys/authenticate-options', {})).statusCode).toBe(
        200,
      );
    expect((await f.request('POST', '/api/passkeys/authenticate-options', {})).statusCode).toBe(
      429,
    );
  });
  it('checks ownership on removal and audits the confirmed deletion', async () => {
    const other = workKey('auth');
    await f.db.orm
      .insert(users)
      .values({ id: other, name: 'Other', email: 'phase11-other@example.test' });
    const id = workKey('auth');
    await f.db.orm.insert(passkeys).values({
      id,
      userId: other,
      credentialID: 'other-credential',
      publicKey: 'public-key',
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
    });
    expect((await f.request('POST', '/api/passkeys/remove', { id })).statusCode).toBe(400);
    const [own] = await f.db.orm.select().from(passkeys).where(eq(passkeys.userId, f.userId));
    expect(own).toBeDefined();
    expect((await f.request('POST', '/api/passkeys/remove', { id: own!.id })).statusCode).toBe(200);
    expect(
      (await exportAudit(f.db, 0, 1000)).entries.some(
        (entry) => entry.payload[2] === 'passkey.deleted' && entry.payload[3] === own!.id,
      ),
    ).toBe(true);
    await f.db.orm.delete(users).where(eq(users.id, other));
  });
  it('requires a recent login before changing credentials', async () => {
    await f.db.orm
      .update(sessions)
      .set({ createdAt: new Date(Date.now() - 360000) })
      .where(eq(sessions.userId, f.userId));
    try {
      expect((await f.request('POST', '/api/passkeys/register-options', {})).statusCode).toBe(401);
      expect(
        (await f.request('POST', '/api/passkeys/remove', { id: workKey('auth') })).statusCode,
      ).toBe(401);
      expect((await f.request('GET', '/api/passkeys')).statusCode).toBe(200);
    } finally {
      await f.db.orm
        .update(sessions)
        .set({ createdAt: new Date() })
        .where(eq(sessions.userId, f.userId));
    }
  });
  it('serializes concurrent appends, ignores duplicate IDs and rolls the chain head back with its transaction', async () => {
    const before = await exportAudit(f.db, 0, 1000);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        f.db.orm.insert(auditLog).values({
          id: workKey('aud'),
          actorId: f.userId,
          action: 'test.concurrent',
          target: String(i),
        }),
      ),
    );
    const id = workKey('aud');
    for (let i = 0; i < 2; i++)
      await f.db.orm
        .insert(auditLog)
        .values({ id, actorId: f.userId, action: 'test.idempotent', target: 'same' })
        .onConflictDoNothing();
    await expect(
      f.db.orm.transaction(async (tx) => {
        await tx.insert(auditLog).values({
          id: workKey('aud'),
          actorId: f.userId,
          action: 'test.rollback',
          target: 'rolled back',
        });
        throw new Error('Rollback fixture');
      }),
    ).rejects.toThrow('Rollback fixture');
    const result = await exportAudit(f.db, 0, 1000);
    expect(result.head.sequence - before.head.sequence).toBe(9);
    expect(verifyAuditExport(result)).toBe(true);
    expect(result.entries.some((entry) => entry.payload[2] === 'test.rollback')).toBe(false);
    await expect(
      f.db.orm.update(auditLog).set({ target: 'changed' }).where(eq(auditLog.id, id)),
    ).rejects.toThrow();
    await expect(f.db.orm.delete(auditLog).where(eq(auditLog.id, id))).rejects.toThrow();
  });
  it('exports an anchored snapshot in pages and detects tampering, gaps, reordering and a truncated suffix', async () => {
    const first = auditExportSchema.parse(
      (await f.request('GET', '/api/audit/export?limit=5')).json<unknown>(),
    );
    const second = await exportAudit(
      f.db,
      first.entries.at(-1)!.sequence,
      1000,
      first.head.sequence,
    );
    const bundle = { format: 'sazuz-audit-bundle-v1', head: first.head, pages: [first, second] };
    expect(verifyAuditBundle(bundle, first.head)).toBe(true);
    const tampered = structuredClone(bundle);
    tampered.pages[1]!.entries[0]!.payload[3] = 'altered';
    expect(verifyAuditBundle(tampered, first.head)).toBe(false);
    const truncated = structuredClone(bundle);
    truncated.pages[1]!.entries.pop();
    expect(verifyAuditBundle(truncated, first.head)).toBe(false);
    expect(verifyAuditBundle({ ...bundle, pages: [second, first] }, first.head)).toBe(false);
    const changedHead = { sequence: first.head.sequence, hash: 'f'.repeat(64) };
    expect(verifyAuditBundle(bundle, changedHead)).toBe(false);
    const denied = await f.request('GET', '/api/audit/export', undefined, false);
    expect(denied.statusCode).toBe(401);
  });
});
