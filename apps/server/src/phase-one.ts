import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ensurePlumbing,
  readPlumbing,
  ensureSetupToken,
  deleteSetupToken,
  type InfraConfig,
} from '@sazuz/config';
import {
  initializeSettings,
  installations,
  listenSettings,
  readSettings,
  securityRateLimits,
  setupSessions,
  vaultRepository,
  type Database,
} from '@sazuz/db';
import { newWorkspaceId, Vault } from '@sazuz/vault';
import { eq, gt, and, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { createAuth } from './auth.js';
import { RequestError } from './phase-one-errors.js';

export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function sameToken(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(tokenHash(left)), Buffer.from(tokenHash(right)));
}
export function requestHeaders(request: FastifyRequest): Headers {
  const result = new Headers();
  for (const name of ['cookie', 'origin', 'content-type', 'user-agent']) {
    const value = request.headers[name];
    if (typeof value === 'string') result.set(name, value);
  }
  return result;
}
export async function createPhaseOne(database: Database, config: InfraConfig) {
  let [installation] = await database.orm.select().from(installations).limit(1);
  const plumbing = installation
    ? await readPlumbing(config.dataDir)
    : await ensurePlumbing(config.dataDir);
  if (!installation) {
    const token = await ensureSetupToken(config.dataDir);
    await database.orm
      .insert(installations)
      .values({ workspaceId: newWorkspaceId(), tokenHash: tokenHash(token) })
      .onConflictDoNothing();
    [installation] = await database.orm.select().from(installations).limit(1);
  }
  if (!installation)
    throw new RequestError('SETUP_UNAVAILABLE', 503, 'Setup could not initialize.');
  if (installation.completedAt) await deleteSetupToken(config.dataDir);
  await initializeSettings(database, `http://localhost:${config.webPort}`);
  const vault = new Vault(
    vaultRepository(database),
    installation.workspaceId,
    plumbing.machineKey,
    Buffer.from(plumbing.sessionKey, 'base64url'),
  );
  const status = await vault.status();
  if (status.initialized && status.mode === 'auto') await vault.unlock();
  let settings = await readSettings(database);
  let auth = createAuth(database, vault, plumbing.sessionKey, settings);
  const listener = await listenSettings(database, (document) => {
    if (
      settings.general.version !== document.general.version ||
      settings.security.version !== document.security.version
    )
      auth = createAuth(database, vault, plumbing.sessionKey, document);
    settings = document;
    database.logger.level = settings.advanced.value.logLevel;
  });
  async function state() {
    const [current] = await database.orm.select().from(installations).limit(1);
    if (!current) throw new RequestError('SETUP_UNAVAILABLE', 503, 'Setup is unavailable.');
    return current;
  }
  async function gate(request: FastifyRequest) {
    const token = request.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('sazuz-setup='))
      ?.slice('sazuz-setup='.length);
    if (!token || token.length > 128 || (await state()).completedAt) return false;
    const [session] = await database.orm
      .select()
      .from(setupSessions)
      .where(
        and(eq(setupSessions.tokenHash, tokenHash(token)), gt(setupSessions.expiresAt, new Date())),
      )
      .limit(1);
    return session !== undefined;
  }
  async function admin(request: FastifyRequest) {
    const session = await auth.api.getSession({ headers: requestHeaders(request) });
    if (
      !session ||
      session.user.id !== (await state()).adminId ||
      Date.now() - session.session.createdAt.getTime() >
        settings.security.value.sessionTimeoutMinutes * 60_000
    )
      throw new RequestError('AUTH_REQUIRED', 401, 'Sign in to continue.');
    if (settings.security.value.requireTwoFactor && !session.user.twoFactorEnabled)
      throw new RequestError(
        'TWO_FACTOR_REQUIRED',
        403,
        'Enable two-factor authentication to continue.',
      );
    return session;
  }
  async function requireSetup(request: FastifyRequest, requireAdmin = true) {
    const current = await state();
    if (current.completedAt) throw new RequestError('NOT_FOUND', 404, 'Setup is complete.');
    if (!(await gate(request)))
      throw new RequestError('SETUP_TOKEN_REQUIRED', 401, 'Enter the setup token.');
    if (requireAdmin && current.adminId) await admin(request);
    return current;
  }
  async function rateLimit(key: string, maximum: number, seconds = 60) {
    const expires = new Date(Date.now() + seconds * 1000);
    const [row] = await database.orm
      .insert(securityRateLimits)
      .values({ key: tokenHash(key), count: 1, expiresAt: expires })
      .onConflictDoUpdate({
        target: securityRateLimits.key,
        set: {
          count: sql`CASE WHEN ${securityRateLimits.expiresAt} <= now() THEN 1 ELSE ${securityRateLimits.count} + 1 END`,
          expiresAt: sql`CASE WHEN ${securityRateLimits.expiresAt} <= now() THEN ${expires} ELSE ${securityRateLimits.expiresAt} END`,
        },
      })
      .returning();
    if (!row || row.count > maximum)
      throw new RequestError('RATE_LIMITED', 429, 'Too many attempts. Try again later.');
  }
  function verifyOrigin(request: FastifyRequest, requireJson = true) {
    const expected = new URL(settings.general.value.baseUrl);
    let origin: URL;
    try {
      origin = new URL(String(request.headers.origin));
    } catch {
      throw new RequestError('ORIGIN_REQUIRED', 403, 'Use the Sazuz web app for this request.');
    }
    const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
    const allowed =
      origin.origin === expected.origin ||
      (loopback(origin.hostname) &&
        loopback(expected.hostname) &&
        origin.protocol === expected.protocol &&
        origin.port === expected.port);
    if (
      !allowed ||
      (origin.protocol !== 'https:' && !loopback(origin.hostname)) ||
      (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') ||
      (requireJson && !request.headers['content-type']?.startsWith('application/json'))
    )
      throw new RequestError('ORIGIN_REJECTED', 403, 'Use a secure, same-origin Sazuz connection.');
  }
  return {
    database,
    config,
    vault,
    plumbing,
    state,
    gate,
    admin,
    requireSetup,
    rateLimit,
    verifyOrigin,
    get settings() {
      return settings;
    },
    get auth() {
      return auth;
    },
    async close() {
      await listener.close();
      await vault.lock();
    },
    async newGate() {
      const token = randomBytes(32).toString('base64url');
      await database.orm
        .insert(setupSessions)
        .values({ tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 86_400_000) });
      return token;
    },
  };
}
export type PhaseOne = Awaited<ReturnType<typeof createPhaseOne>>;
