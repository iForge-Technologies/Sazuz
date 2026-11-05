import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  auditLog,
  exportAudit,
  passkeys,
  readAudit,
  workKey,
  workspaceMemberships,
} from '@sazuz/db';
import { secretRedactor } from '@sazuz/vault';
import {
  auditExportSchema,
  auditPageSchema,
  passkeyAuthenticationSchema,
  passkeyAuthenticateOptionsSchema,
  passkeyIdSchema,
  passkeyListSchema,
  passkeyRegisterOptionsSchema,
  passkeyRegistrationSchema,
} from '@sazuz/core/audit';
import { verifyAuditExport } from '@sazuz/core/audit-verify';
import type { createApp } from './app.js';
import { requestHeaders, type PhaseOne } from './phase-one.js';
import { RequestError } from './phase-one-errors.js';
import { parseRequest, emptyRequest } from './phase-three-shared.js';

type App = Awaited<ReturnType<typeof createApp>>;
const cursor = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ok = z.strictObject({ ok: z.literal(true) });

export function registerIdentity(app: App, runtime: PhaseOne) {
  app.get(
    '/api/audit',
    {
      schema: {
        querystring: z.strictObject({
          before: cursor.optional(),
          action: z.string().min(1).max(256).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: { 200: auditPageSchema },
      },
    },
    async (request) => {
      await runtime.admin(request);
      return readAudit(runtime.database, request.query);
    },
  );
  app.get(
    '/api/audit/export',
    {
      schema: {
        querystring: z.strictObject({
          after: cursor.default(0),
          limit: z.coerce.number().int().min(1).max(1000).default(1000),
          through: cursor.optional(),
        }),
        response: { 200: auditExportSchema },
      },
    },
    async (request) => {
      await runtime.admin(request);
      const result = await exportAudit(
        runtime.database,
        request.query.after,
        request.query.limit,
        request.query.through,
      );
      if (!verifyAuditExport(result))
        throw new RequestError(
          'AUDIT_INTEGRITY_FAILED',
          409,
          'Audit history failed its integrity check. Preserve the database and your last trusted export.',
        );
      return result;
    },
  );
  app.get(
    '/api/operations/identity',
    {
      schema: {
        querystring: emptyRequest,
        response: {
          200: z.strictObject({
            workspaceId: z.string(),
            userId: z.string(),
            role: z.literal('owner'),
            passkeyOrigin: z.string(),
          }),
        },
      },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      const [membership] = await runtime.database.orm
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.userId, user.id));
      if (!membership)
        throw new RequestError('MEMBERSHIP_UNAVAILABLE', 409, 'Owner membership is unavailable.');
      return {
        workspaceId: membership.workspaceId,
        userId: user.id,
        role: 'owner' as const,
        passkeyOrigin: new URL(runtime.settings.general.value.baseUrl).origin,
      };
    },
  );
  app.get(
    '/api/passkeys',
    { schema: { querystring: emptyRequest, response: { 200: passkeyListSchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      return (
        await runtime.database.orm.select().from(passkeys).where(eq(passkeys.userId, user.id))
      ).map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt.toISOString(),
        backedUp: row.backedUp,
      }));
    },
  );
  async function fresh(request: Parameters<PhaseOne['admin']>[0]) {
    const session = await runtime.admin(request);
    if (Date.now() - session.session.createdAt.getTime() > 300000)
      throw new RequestError(
        'FRESH_SESSION_REQUIRED',
        401,
        'Sign in again before changing passkeys.',
      );
    return session;
  }
  async function exchange(
    request: Parameters<PhaseOne['admin']>[0],
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ) {
    parseRequest(emptyRequest, request.query);
    await runtime.rateLimit(`passkey:${request.ip}`, 10);
    await runtime.rateLimit('passkey:global', 40);
    const headers = requestHeaders(request);
    headers.set('content-type', 'application/json');
    const response = await runtime.auth.handler(
      new Request(new URL(`/api/auth/passkey/${path}`, runtime.settings.general.value.baseUrl), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new RequestError(
        'PASSKEY_FAILED',
        400,
        'Passkey verification failed. Check the site address, sign in again, or use a different authenticator.',
      );
    }
    const value: unknown = await response.json();
    return { value, cookies: response.headers.getSetCookie() };
  }
  app.post(
    '/api/passkeys/register-options',
    { schema: { body: emptyRequest, response: { 200: passkeyRegisterOptionsSchema } } },
    async (request, reply) => {
      const { user } = await fresh(request);
      const saved = await runtime.database.orm
        .select({ id: passkeys.id })
        .from(passkeys)
        .where(eq(passkeys.userId, user.id));
      if (saved.length >= 10)
        throw new RequestError('PASSKEY_LIMIT', 409, 'Remove a passkey before adding another.');
      const result = await exchange(request, 'generate-register-options', 'GET');
      const options = passkeyRegisterOptionsSchema.parse(result.value);
      reply.header('Set-Cookie', result.cookies);
      return options;
    },
  );
  app.post(
    '/api/passkeys/register',
    { schema: { body: passkeyRegistrationSchema, response: { 200: ok } } },
    async (request, reply) => {
      await fresh(request);
      if (secretRedactor.redactText(request.body.name) !== request.body.name)
        throw new RequestError('INVALID_REQUEST', 400, 'Choose a label without credentials.');
      const result = await exchange(request, 'verify-registration', 'POST', request.body);
      z.object({ id: passkeyIdSchema }).parse(result.value);
      reply.header('Set-Cookie', result.cookies);
      return { ok: true as const };
    },
  );
  app.post(
    '/api/passkeys/authenticate-options',
    { schema: { body: emptyRequest, response: { 200: passkeyAuthenticateOptionsSchema } } },
    async (request, reply) => {
      const result = await exchange(request, 'generate-authenticate-options', 'GET');
      const raw = z.record(z.string(), z.unknown()).parse(result.value);
      const options = passkeyAuthenticateOptionsSchema.parse({
        ...raw,
        userVerification: 'required',
      });
      reply.header('Set-Cookie', result.cookies);
      return options;
    },
  );
  app.post(
    '/api/passkeys/authenticate',
    { schema: { body: passkeyAuthenticationSchema, response: { 200: ok } } },
    async (request, reply) => {
      const result = await exchange(request, 'verify-authentication', 'POST', request.body);
      const verified = z.object({ user: z.object({ id: z.string() }) }).parse(result.value);
      if (verified.user.id !== (await runtime.state()).adminId)
        throw new RequestError('AUTH_REQUIRED', 401, 'Sign in as the workspace owner.');
      await runtime.database.orm.insert(auditLog).values({
        id: workKey('aud'),
        actorId: verified.user.id,
        action: 'passkey.authenticated',
        target: 'session',
      });
      reply.header('Set-Cookie', result.cookies);
      return { ok: true as const };
    },
  );
  app.post(
    '/api/passkeys/remove',
    { schema: { body: z.strictObject({ id: passkeyIdSchema }), response: { 200: ok } } },
    async (request, reply) => {
      await fresh(request);
      const result = await exchange(request, 'delete-passkey', 'POST', request.body);
      z.object({ status: z.literal(true) }).parse(result.value);
      reply.header('Set-Cookie', result.cookies);
      return { ok: true as const };
    },
  );
}
