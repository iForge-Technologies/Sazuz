import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, passkeys, pushDevices, sessions, verifications, workKey } from '@sazuz/db';
import { passkeyAuthenticateOptionsSchema, passkeyRegisterOptionsSchema } from '@sazuz/core/audit';
import { registerIdentity } from '../../apps/server/src/phase-eleven-identity.js';
import { phaseFourFixture } from './phase-four-fixture.js';
import { authenticatorFixture } from './phase-eleven-authenticator.js';

describe('Phase 11 operator credential recovery', () => {
  let f: Awaited<ReturnType<typeof phaseFourFixture>>;
  beforeAll(async () => {
    f = await phaseFourFixture(registerIdentity);
  });
  afterAll(async () => {
    await f?.close();
  });
  it('atomically revokes passkeys, push devices, sessions and outstanding challenges with its audit', async () => {
    const key = authenticatorFixture();
    const options = await f.request('POST', '/api/passkeys/register-options', {});
    expect(options.statusCode).toBe(200);
    const enrolled = await f.request(
      'POST',
      '/api/passkeys/register',
      key.register(passkeyRegisterOptionsSchema.parse(options.json<unknown>())),
    );
    expect(enrolled.statusCode, enrolled.body).toBe(200);
    const challenge = await f.request('POST', '/api/passkeys/authenticate-options', {});
    expect(challenge.statusCode).toBe(200);
    const assertion = key.authenticate(
      passkeyAuthenticateOptionsSchema.parse(challenge.json<unknown>()),
    );
    const secret = await f.runtime.vault.create(
      { name: 'Reset push device', value: 'private-reset-device-canary', createdBy: f.userId },
      'web-push',
    );
    const deviceId = workKey('psh');
    await f.db.orm.insert(pushDevices).values({
      id: deviceId,
      userId: f.userId,
      name: 'Revoked by operator',
      endpointHash: 'a'.repeat(64),
      secretRef: secret.reference,
    });
    const priorChallenges = await f.db.orm.select().from(verifications);
    expect(priorChallenges.length).toBeGreaterThan(0);
    const payload = { password: 'New-operator-password-564123' };
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${f.runtime.plumbing.operatorKey}`,
    };
    const reset = (remoteAddress = '127.0.0.1') =>
      f.app.inject({
        method: 'POST',
        url: '/api/operator/reset-admin',
        remoteAddress,
        headers,
        payload,
      });
    expect((await reset('192.0.2.20')).statusCode).toBe(403);
    await f.db.pool
      .query(`CREATE FUNCTION phase11_refuse_reset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='admin.reset' THEN RAISE EXCEPTION 'reset audit refused'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER phase11_refuse_reset BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION phase11_refuse_reset();`);
    try {
      expect((await reset()).statusCode).toBe(500);
      expect(await f.db.orm.select().from(passkeys)).toHaveLength(1);
      expect(await f.db.orm.select().from(verifications)).toEqual(priorChallenges);
      expect((await f.db.orm.select().from(pushDevices))[0]?.revokedAt).toBeNull();
      expect((await f.request('GET', '/api/settings')).statusCode).toBe(200);
    } finally {
      await f.db.pool.query(
        'DROP TRIGGER phase11_refuse_reset ON audit_log; DROP FUNCTION phase11_refuse_reset()',
      );
    }
    const result = await reset();
    expect(result.statusCode, result.body).toBe(200);
    expect(await f.db.orm.select().from(passkeys)).toHaveLength(0);
    expect(await f.db.orm.select().from(sessions)).toHaveLength(0);
    expect(await f.db.orm.select().from(verifications)).toHaveLength(0);
    expect((await f.db.orm.select().from(pushDevices))[0]?.revokedAt).toBeInstanceOf(Date);
    expect((await f.request('GET', '/api/settings')).statusCode).toBe(401);
    expect((await f.request('POST', '/api/passkeys/authenticate', assertion)).statusCode).toBe(400);
    expect(
      await f.db.orm.select().from(auditLog).where(eq(auditLog.action, 'admin.reset')),
    ).toHaveLength(1);
    const signedIn = await f.request('POST', '/api/auth/sign-in/email', {
      email: 'phase4@example.test',
      password: payload.password,
    });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    expect(f.logLines.join('')).not.toContain(payload.password);
    expect(f.logLines.join('')).not.toContain('private-reset-device-canary');
  });
});
