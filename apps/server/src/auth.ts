import { betterAuth, type BetterAuthOptions, type DBAdapter, type Where } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import {
  accounts,
  authRateLimits,
  sessions,
  twoFactors,
  users,
  verifications,
  passkeys,
  type Database,
} from '@sazuz/db';
import { type Vault, type SecretReference } from '@sazuz/vault';
import type { SettingsDocument } from '@sazuz/config/settings';
import { ulid } from 'ulid';
import { RequestError } from './phase-one-errors.js';

/** Better Auth owns session/TOTP semantics. Its sensitive fields are vault handles at rest. */
export function protectAuthAdapter(adapter: DBAdapter, vault: Vault): DBAdapter {
  const handles = new Map<string, string>();
  const fields = ['secret', 'backupCodes'];
  async function protect<T>(model: string, input: T): Promise<T> {
    if (model !== 'twoFactor' || input === null || typeof input !== 'object') return input;
    const result = { ...input } as Record<string, unknown>;
    for (const field of fields) {
      const value = result[field];
      if (typeof value === 'string') {
        const saved = await vault.create(
          { name: `auth-${field}`, value, createdBy: 'system' },
          'authentication',
        );
        result[field] = saved.reference;
        handles.set(value, saved.reference);
      }
    }
    return result as T;
  }
  async function reveal<T>(model: string, input: T): Promise<T> {
    if (model !== 'twoFactor' || input === null || typeof input !== 'object') return input;
    const result = { ...input } as Record<string, unknown>;
    for (const field of fields) {
      const value = result[field];
      if (typeof value === 'string' && value.startsWith('secret://')) {
        result[field] = await vault.withSecret(
          value as SecretReference,
          'authentication',
          (resolved) => {
            handles.set(resolved, value);
            return resolved;
          },
        );
      }
    }
    return result as T;
  }
  const where = (model: string, conditions: Where[]) =>
    model === 'twoFactor'
      ? conditions.map((condition) => ({
          ...condition,
          value:
            fields.includes(condition.field) && typeof condition.value === 'string'
              ? (handles.get(condition.value) ?? condition.value)
              : condition.value,
        }))
      : conditions;
  return {
    ...adapter,
    async create<T extends Record<string, unknown>, R = T>(input: {
      model: string;
      data: Omit<T, 'id'>;
      select?: string[] | undefined;
      forceAllowId?: boolean | undefined;
    }): Promise<R> {
      return reveal(
        input.model,
        await adapter.create<T, R>({ ...input, data: await protect(input.model, input.data) }),
      );
    },
    async findOne<T>(input: Parameters<DBAdapter['findOne']>[0]): Promise<T | null> {
      return reveal(
        input.model,
        await adapter.findOne<T>({ ...input, where: where(input.model, input.where) }),
      );
    },
    async findMany<T>(input: Parameters<DBAdapter['findMany']>[0]): Promise<T[]> {
      return Promise.all((await adapter.findMany<T>(input)).map((row) => reveal(input.model, row)));
    },
    async update<T>(input: Parameters<DBAdapter['update']>[0]): Promise<T | null> {
      if (
        input.model === 'passkey' &&
        typeof input.update.counter === 'number' &&
        input.update.counter > 0
      ) {
        const updated = await adapter.update<T>({
          ...input,
          where: [
            ...input.where,
            { field: 'counter', operator: 'lt', value: input.update.counter },
          ],
        });
        if (!updated) throw new RequestError('AUTH_FAILED', 401, 'Passkey verification failed.');
        return updated;
      }
      return reveal(
        input.model,
        await adapter.update<T>({
          ...input,
          where: where(input.model, input.where),
          update: await protect(input.model, input.update),
        }),
      );
    },
    async updateMany(input) {
      return adapter.updateMany({
        ...input,
        where: where(input.model, input.where),
        update: await protect(input.model, input.update),
      });
    },
    async incrementOne<T>(input: Parameters<DBAdapter['incrementOne']>[0]): Promise<T | null> {
      return reveal(
        input.model,
        await adapter.incrementOne<T>({
          ...input,
          where: where(input.model, input.where),
          ...(input.set ? { set: await protect(input.model, input.set) } : {}),
        }),
      );
    },
    async transaction(callback) {
      return adapter.transaction((tx) =>
        callback(protectAuthAdapter({ ...tx, transaction: adapter.transaction }, vault)),
      );
    },
  };
}

export function createAuth(
  database: Database,
  vault: Vault,
  sessionKey: string,
  settings: SettingsDocument,
) {
  const baseURL = settings.general.value.baseUrl;
  const url = new URL(baseURL);
  const origins = [url.origin];
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    for (const host of ['localhost', '127.0.0.1', '[::1]'])
      origins.push(`${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`);
  }
  const adapter = drizzleAdapter(database.orm, {
    provider: 'pg',
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
      twoFactor: twoFactors,
      rateLimit: authRateLimits,
      passkey: passkeys,
    },
  });
  return betterAuth({
    appName: 'Sazuz',
    baseURL,
    basePath: '/api/auth',
    secret: sessionKey,
    database: (options: BetterAuthOptions) => protectAuthAdapter(adapter(options), vault),
    trustedOrigins: origins,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: settings.security.value.sessionTimeoutMinutes * 60,
      updateAge: 300,
      cookieCache: { enabled: false },
      freshAge: 300,
    },
    advanced: {
      useSecureCookies: url.protocol === 'https:',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'strict', path: '/' },
      database: { generateId: () => `auth_${ulid()}` },
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 30 },
    logger: { disabled: true },
    plugins: [
      passkey({
        rpID: url.hostname,
        rpName: 'Sazuz',
        origin: url.origin,
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        registration: {
          requireSession: true,
          afterVerification({ verification }) {
            if (!verification.registrationInfo?.userVerified)
              throw new RequestError(
                'AUTH_FAILED',
                401,
                'Verify your identity on the authenticator.',
              );
          },
        },
        authentication: {
          afterVerification({ verification }) {
            if (!verification.authenticationInfo.userVerified)
              throw new RequestError(
                'AUTH_FAILED',
                401,
                'Verify your identity on the authenticator.',
              );
          },
        },
      }),
      twoFactor({
        issuer: 'Sazuz',
        skipVerificationOnEnable: false,
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 },
      }),
    ],
  });
}
