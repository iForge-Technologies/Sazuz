import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { deleteSetupToken } from '@sazuz/config';
import {
  adminRequestSchema,
  gateRequestSchema,
  passwordSchema,
  settingRequestSchema,
  setupStatusSchema,
  stepRequestSchema,
} from '@sazuz/config/contracts';
import {
  defaultSettings,
  namespaceSchema,
  parseSetting,
  type SettingsNamespace,
} from '@sazuz/config/settings';
import {
  accounts,
  auditLog,
  installations,
  passkeys,
  pushDevices,
  readSettings,
  readSettingsHistory,
  rollbackSetting,
  saveSetting,
  saveSettingIn,
  settings,
  sessions,
  setupSessions,
  twoFactors,
  users,
  verifications,
  workerSettings,
} from '@sazuz/db';
import { secretIdSchema, secretRedactor } from '@sazuz/vault';
import type { createApp } from './app.js';
import { requestHeaders, sameToken, tokenHash, type PhaseOne } from './phase-one.js';
import { RequestError } from './phase-one-errors.js';

const empty = z.strictObject({});
const passphrase = z.string().min(12).max(256);
const vaultInit = z.strictObject({ passphrase, mode: z.enum(['auto', 'strict']) });
const vaultUnlock = z.strictObject({ passphrase: z.string().min(1).max(256) });
const confirmation = z.strictObject({ characters: z.string().length(4) });
const secretInput = z.strictObject({
  name: z.string().trim().min(1).max(128),
  value: z.string().min(1).max(65_536),
});
const idParams = z.strictObject({ id: secretIdSchema });
const nsParams = z.strictObject({ namespace: namespaceSchema });
const authPaths = {
  'sign-in/email': z.strictObject({
    email: z.email().max(254),
    password: z.string().min(1).max(128),
    rememberMe: z.boolean().optional(),
  }),
  'sign-out': empty,
  'two-factor/enable': z.strictObject({ password: z.string().min(1).max(128) }),
  'two-factor/disable': z.strictObject({ password: z.string().min(1).max(128) }),
  'two-factor/verify-totp': z.strictObject({ code: z.string().regex(/^\d{6}$/) }),
  'two-factor/verify-backup-code': z.strictObject({ code: z.string().min(1).max(64) }),
} as const;
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new RequestError('INVALID_REQUEST', 400, 'Check the submitted fields.');
  return parsed.data;
}

export function registerPhaseOne(app: Awaited<ReturnType<typeof createApp>>, runtime: PhaseOne) {
  const { database, vault } = runtime;
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !request.url.startsWith('/api/operator/') &&
      request.url !== '/internal/execution' &&
      request.url !== '/internal/browser-execution' &&
      request.url !== '/internal/browser-image' &&
      request.url !== '/internal/external-execution' &&
      request.url !== '/mcp' &&
      !/^\/hooks\/[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/.test(request.url)
    )
      runtime.verifyOrigin(request);
    if (request.url.startsWith('/api/operator/')) {
      const authorization = request.headers.authorization;
      if (
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip) ||
        typeof authorization !== 'string' ||
        !sameToken(authorization, `Bearer ${runtime.plumbing.operatorKey}`)
      )
        throw new RequestError('OPERATOR_REQUIRED', 403, 'Run this command on the Sazuz host.');
    }
  });
  app.get('/api/setup/status', async (request) => {
    parse(empty, request.query);
    const state = await runtime.state();
    const gateOpen = await runtime.gate(request);
    const session = await runtime.auth.api.getSession({ headers: requestHeaders(request) });
    const authenticated = session?.user.id === state.adminId && session !== null;
    return setupStatusSchema.parse({
      completed: state.completedAt !== null,
      gateOpen,
      authenticated,
      currentStep: gateOpen ? state.currentStep : 0,
      adminCreated: state.adminId !== null,
      vault:
        gateOpen || authenticated
          ? await vault.status()
          : { initialized: false, locked: true, mode: null, recoveryConfirmed: false },
      settings: gateOpen && (!state.adminId || authenticated) ? await readSettings(database) : null,
      team:
        gateOpen && (!state.adminId || authenticated)
          ? runtime.settings.advanced.value.team
          : defaultSettings.advanced.team,
      csrfToken: null,
    });
  });
  app.post('/api/setup/gate', async (request, reply) => {
    const state = await runtime.state();
    if (state.completedAt) throw new RequestError('NOT_FOUND', 404, 'Setup is complete.');
    await runtime.rateLimit('setup-gate', 5);
    const { token } = parse(gateRequestSchema, request.body);
    if (!state.tokenHash || !sameToken(tokenHash(token), state.tokenHash))
      throw new RequestError('SETUP_TOKEN_INVALID', 401, 'The setup token is invalid.');
    const gate = await runtime.newGate();
    const secure =
      new URL(runtime.settings.general.value.baseUrl).protocol === 'https:' ? '; Secure' : '';
    reply.header(
      'Set-Cookie',
      `sazuz-setup=${gate}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure}`,
    );
    await database.orm
      .update(installations)
      .set({ currentStep: 1 })
      .where(and(eq(installations.id, 'singleton'), eq(installations.currentStep, 0)));
    return { ok: true };
  });
  app.post('/api/setup/admin', async (request) => {
    await runtime.requireSetup(request, false);
    await runtime.rateLimit('setup-admin', 5);
    const body = parse(adminRequestSchema, request.body);
    secretRedactor.register(body.password);
    const password = await hashPassword(body.password);
    await database.orm.transaction(async (tx) => {
      const [state] = await tx
        .select()
        .from(installations)
        .where(eq(installations.id, 'singleton'))
        .for('update');
      if (!state || state.adminId || state.completedAt)
        throw new RequestError(
          'ADMIN_EXISTS',
          409,
          'An admin already exists. Sign in to resume setup.',
        );
      const id = `usr_${ulid()}`;
      await tx.insert(users).values({ id, name: body.name, email: body.email.toLowerCase() });
      await tx.insert(accounts).values({
        id: `acc_${ulid()}`,
        userId: id,
        accountId: id,
        providerId: 'credential',
        password,
      });
      await tx
        .update(installations)
        .set({ adminId: id, currentStep: 3 })
        .where(eq(installations.id, 'singleton'));
      await tx
        .insert(auditLog)
        .values({ id: `aud_${ulid()}`, actorId: id, action: 'admin.created', target: id });
    });
    return { ok: true };
  });
  app.post('/api/setup/step', async (request) => {
    const current = await runtime.requireSetup(request);
    const body = parse(stepRequestSchema, request.body);
    if (body.step > current.currentStep + 1)
      throw new RequestError('SETUP_STEP_INVALID', 409, 'Finish the current screen first.');
    if (body.step >= 3 && !current.adminId)
      throw new RequestError('ADMIN_REQUIRED', 409, 'Create the admin account first.');
    if (body.step >= 4 && !(await vault.status()).recoveryConfirmed)
      throw new RequestError('RECOVERY_REQUIRED', 409, 'Save and confirm your recovery kit first.');
    if (body.namespace) {
      if (body.expectedVersion === undefined)
        throw new RequestError('INVALID_REQUEST', 400, 'A settings version is required.');
      await validateReferences(body.namespace, body.value);
      await saveSetting(database, {
        namespace: body.namespace,
        value: body.value,
        expectedVersion: body.expectedVersion,
        actorId: current.adminId ?? 'setup',
      });
    }
    if (body.step > 4 && (await readSettings(database)).providers.value.items.length === 0)
      throw new RequestError('PROVIDER_REQUIRED', 409, 'Add at least one provider.');
    await database.orm
      .update(installations)
      .set({ currentStep: body.step })
      .where(eq(installations.id, 'singleton'));
    return { ok: true };
  });
  app.post('/api/setup/complete', async (request, reply) => {
    parse(empty, request.body);
    const current = await runtime.requireSetup(request);
    if (
      !current.adminId ||
      current.currentStep !== 12 ||
      !(await vault.status()).recoveryConfirmed ||
      (await readSettings(database)).providers.value.items.length === 0
    )
      throw new RequestError('SETUP_INCOMPLETE', 409, 'Finish the required setup screens.');
    await database.orm.transaction(async (tx) => {
      await tx
        .update(installations)
        .set({ completedAt: new Date(), tokenHash: null })
        .where(eq(installations.id, 'singleton'));
      await tx.delete(setupSessions);
      await tx.insert(auditLog).values({
        id: `aud_${ulid()}`,
        actorId: current.adminId!,
        action: 'setup.completed',
        target: 'installation',
      });
    });
    await deleteSetupToken(runtime.config.dataDir);
    reply.header('Set-Cookie', 'sazuz-setup=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return { ok: true };
  });
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      const path = parse(z.strictObject({ '*': z.string().max(100) }), request.params)['*'];
      parse(empty, request.query);
      if (request.method === 'GET') {
        if (path !== 'get-session')
          throw new RequestError('NOT_FOUND', 404, 'That authentication endpoint is unavailable.');
        const session = await runtime.auth.api.getSession({ headers: requestHeaders(request) });
        return session
          ? {
              user: {
                id: session.user.id,
                name: session.user.name,
                email: session.user.email,
                twoFactorEnabled: session.user.twoFactorEnabled,
              },
            }
          : null;
      }
      if (!(path in authPaths))
        throw new RequestError('NOT_FOUND', 404, 'That authentication endpoint is unavailable.');
      const body = parse<unknown>(authPaths[path as keyof typeof authPaths], request.body);
      await runtime.rateLimit(`auth:${path}`, 20);
      if (path === 'two-factor/disable' && runtime.settings.security.value.requireTwoFactor)
        throw new RequestError(
          'TWO_FACTOR_REQUIRED',
          409,
          'Turn off the two-factor requirement in Settings first.',
        );
      const headers = requestHeaders(request);
      headers.set('content-type', 'application/json');
      const response = await runtime.auth.handler(
        new Request(new URL(`/api/auth/${path}`, runtime.settings.general.value.baseUrl), {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
      );
      const payload: unknown = await response.json();
      for (const cookie of response.headers.getSetCookie())
        reply.header('Set-Cookie', [
          ...(Array.isArray(reply.getHeader('Set-Cookie'))
            ? (reply.getHeader('Set-Cookie') as string[])
            : []),
          cookie,
        ]);
      if (!response.ok)
        throw new RequestError(
          'AUTH_FAILED',
          response.status,
          'Authentication failed. Check your credentials or code.',
        );
      const data = parse(
        z.object({
          twoFactorRedirect: z.boolean().optional(),
          totpURI: z.string().optional(),
          backupCodes: z.array(z.string()).optional(),
        }),
        payload,
      );
      if (data.totpURI) {
        secretRedactor.register(data.totpURI);
        for (const code of data.backupCodes ?? []) secretRedactor.register(code);
      }
      return { ok: true, ...data };
    },
  });
  async function validateReferences(namespace: SettingsNamespace, value: unknown) {
    let parsed: ReturnType<typeof parseSetting>;
    try {
      parsed = parseSetting(namespace, value);
    } catch {
      throw new RequestError('SETTINGS_INVALID', 400, 'Check the settings fields.');
    }
    const refs: string[] = [];
    const visit = (entry: unknown): void => {
      if (typeof entry === 'string' && entry.startsWith('secret://')) refs.push(entry);
      else if (Array.isArray(entry)) entry.forEach(visit);
      else if (entry && typeof entry === 'object') Object.values(entry).forEach(visit);
    };
    visit(parsed);
    const available = new Set((await vault.list()).map((item) => item.reference as string));
    if (refs.some((ref) => !available.has(ref)))
      throw new RequestError('SECRET_REFERENCE_INVALID', 400, 'Choose a saved vault credential.');
    if (namespace === 'security' && parseSetting('security', value).requireTwoFactor) {
      const [admin] = await database.orm
        .select()
        .from(users)
        .where(eq(users.id, (await runtime.state()).adminId ?? ''));
      if (!admin?.twoFactorEnabled)
        throw new RequestError(
          'TWO_FACTOR_REQUIRED',
          409,
          'Enable and verify two-factor authentication first.',
        );
    }
  }
  app.get('/api/settings', async (request) => {
    parse(empty, request.query);
    await runtime.admin(request);
    return readSettings(database);
  });
  app.put('/api/settings/:namespace', async (request) => {
    const { user } = await runtime.admin(request);
    const { namespace } = parse(nsParams, request.params);
    const body = parse(settingRequestSchema, request.body);
    await validateReferences(namespace, body.value);
    return saveSetting(database, { namespace, ...body, value: body.value, actorId: user.id });
  });
  app.get('/api/settings/:namespace/history', async (request) => {
    await runtime.admin(request);
    parse(empty, request.query);
    return readSettingsHistory(database, parse(nsParams, request.params).namespace);
  });
  app.post('/api/settings/:namespace/rollback', async (request) => {
    const { user } = await runtime.admin(request);
    const { namespace } = parse(nsParams, request.params);
    const body = parse(
      z.strictObject({
        version: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
      }),
      request.body,
    );
    const previous = (await readSettingsHistory(database, namespace)).find(
      (row) => row.version === body.version,
    );
    if (!previous)
      throw new RequestError('SETTINGS_HISTORY_NOT_FOUND', 404, 'That revision is unavailable.');
    await validateReferences(namespace, previous.value);
    return rollbackSetting(database, namespace, body.version, body.expectedVersion, user.id);
  });
  app.get('/api/settings/workers', async (request) => {
    await runtime.admin(request);
    parse(empty, request.query);
    return database.orm.select().from(workerSettings);
  });
  app.get('/api/vault/status', async (request) => {
    await runtime.admin(request);
    parse(empty, request.query);
    return vault.status();
  });
  app.post('/api/vault/initialize', async (request) => {
    await runtime.requireSetup(request);
    await runtime.admin(request);
    const body = parse(vaultInit, request.body);
    const kit = await vault.initialize(body.passphrase, body.mode);
    return {
      recoveryKit: { text: kit.text, confirmationHint: kit.confirmationHint },
      vault: await vault.status(),
    };
  });
  app.post('/api/vault/confirm-recovery', async (request) => {
    await runtime.admin(request);
    await runtime.rateLimit('recovery-confirm', 10);
    await vault.confirmRecovery(parse(confirmation, request.body).characters);
    return { ok: true };
  });
  app.post('/api/vault/recovery', async (request) => {
    await runtime.admin(request);
    await runtime.rateLimit('vault-unlock', 5);
    const kit = await vault.regenerateRecovery(parse(vaultUnlock, request.body).passphrase);
    return {
      recoveryKit: { text: kit.text, confirmationHint: kit.confirmationHint },
      vault: await vault.status(),
    };
  });
  app.post('/api/vault/unlock', async (request) => {
    await runtime.admin(request);
    await runtime.rateLimit('vault-unlock', 5);
    await vault.unlock(parse(vaultUnlock, request.body).passphrase);
    return vault.status();
  });
  app.post('/api/vault/lock', async (request) => {
    await runtime.admin(request);
    parse(empty, request.body);
    await vault.lock();
    return vault.status();
  });
  app.post('/api/vault/mode', async (request) => {
    await runtime.admin(request);
    await runtime.rateLimit('vault-unlock', 5);
    const body = parse(vaultInit, request.body);
    await vault.changeMode(body.passphrase, body.mode);
    return vault.status();
  });
  app.get('/api/vault/secrets', async (request) => {
    await runtime.admin(request);
    parse(empty, request.query);
    return vault.list();
  });
  app.post('/api/vault/secrets', async (request) => {
    const { user } = await runtime.admin(request);
    return vault.create({ ...parse(secretInput, request.body), createdBy: user.id });
  });
  app.put('/api/vault/secrets/:id', async (request) => {
    await runtime.admin(request);
    const { id } = parse(idParams, request.params);
    const { expectedRevision, ...body } = parse(
      secretInput.extend({ expectedRevision: z.number().int().positive() }),
      request.body,
    );
    return vault.update(id, body, expectedRevision);
  });
  app.delete('/api/vault/secrets/:id', async (request) => {
    await runtime.admin(request);
    parse(empty, request.body);
    const { id } = parse(idParams, request.params);
    if (JSON.stringify(await readSettings(database)).includes(`secret://${id}`))
      throw new RequestError('SECRET_IN_USE', 409, 'Remove this credential from Settings first.');
    await vault.delete(id);
    return { ok: true };
  });
  app.get('/api/operator/status', async (request) => {
    parse(empty, request.query);
    return vault.status();
  });
  app.post('/api/operator/unlock', async (request) => {
    await runtime.rateLimit('operator-unlock', 5);
    await vault.unlock(parse(vaultUnlock, request.body).passphrase);
    return vault.status();
  });
  app.post('/api/operator/reset-admin', async (request) => {
    const { password } = parse(z.strictObject({ password: passwordSchema }), request.body);
    secretRedactor.register(password);
    const id = (await runtime.state()).adminId;
    if (!id) throw new RequestError('ADMIN_MISSING', 409, 'Create the admin in setup first.');
    const hashed = await hashPassword(password);
    await database.orm.transaction(async (tx) => {
      const [security] = await tx
        .select()
        .from(settings)
        .where(eq(settings.namespace, 'security'))
        .for('update');
      await tx
        .update(accounts)
        .set({ password: hashed })
        .where(and(eq(accounts.userId, id), eq(accounts.providerId, 'credential')));
      await tx.update(users).set({ twoFactorEnabled: false }).where(eq(users.id, id));
      await tx.delete(twoFactors).where(eq(twoFactors.userId, id));
      await tx.delete(sessions).where(eq(sessions.userId, id));
      await tx.delete(passkeys).where(eq(passkeys.userId, id));
      await tx.update(pushDevices).set({ revokedAt: new Date() }).where(eq(pushDevices.userId, id));
      // V1 has one owner. Authentication and enrollment challenges issued before
      // recovery must not recreate access after the operator revokes credentials.
      await tx.delete(verifications);
      if (security) {
        const value = parseSetting('security', security.value);
        if (value.requireTwoFactor)
          await saveSettingIn(tx, {
            namespace: 'security',
            expectedVersion: security.version,
            value: { ...value, requireTwoFactor: false },
            actorId: 'operator',
          });
      }
      await tx
        .insert(auditLog)
        .values({ id: `aud_${ulid()}`, actorId: 'operator', action: 'admin.reset', target: id });
    });
    return { ok: true };
  });
}
