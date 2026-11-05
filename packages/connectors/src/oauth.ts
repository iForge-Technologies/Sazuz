import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { secretRedactor } from '@sazuz/vault';
import { z } from 'zod';
import type { ConnectorAccount, ConnectorSecretContext } from './contracts.js';
import { ConnectorError } from './errors.js';
import { parseResponse, requestJson, requireSuccess } from './http.js';
import { useSecret } from './sdk.js';

const redirectSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  });
const allowedGoogleScopes = new Set([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/documents',
]);
const oauthRequestSchema = z.strictObject({
  clientId: z.string().min(1).max(300),
  redirectUri: redirectSchema,
  scopes: z
    .array(z.string().refine((scope) => allowedGoogleScopes.has(scope)))
    .min(1)
    .max(10),
});

export interface GoogleOAuthAttempt {
  authorizationUrl: string;
  stateHash: string;
  codeVerifier: string;
  expiresAt: string;
}

/** Persist the attempt server-side, bound to user and account; expose only authorizationUrl. */
export function createGoogleOAuthRequest(
  input: z.input<typeof oauthRequestSchema>,
  now = new Date(),
): GoogleOAuthAttempt {
  const parsed = oauthRequestSchema.safeParse(input);
  if (!parsed.success || !Number.isFinite(now.getTime()))
    throw new ConnectorError('OAUTH_STATE_INVALID');
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(48).toString('base64url');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: parsed.data.clientId,
    redirect_uri: parsed.data.redirectUri,
    response_type: 'code',
    scope: [...new Set(parsed.data.scopes)].join(' '),
    state,
    code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  return {
    authorizationUrl: url.toString(),
    stateHash: createHash('sha256').update(state).digest('hex'),
    codeVerifier,
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
  };
}

const callbackSchema = z.strictObject({
  state: z.string().min(20).max(200),
  stateHash: z.string().regex(/^[0-9a-f]{64}$/),
  codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  expiresAt: z.iso.datetime(),
  code: z.string().min(1).max(4096),
  clientId: z.string().min(1).max(300),
  clientSecretRef: z.string().regex(/^secret:\/\/[A-Za-z0-9_-]{1,128}$/),
  redirectUri: redirectSchema,
});
export type GoogleOAuthCallback = z.input<typeof callbackSchema>;

const tokenSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).max(16_384).optional(),
  scope: z.string().max(4096).optional(),
});

/** Root atomically consumes the bound OAuth attempt before calling; token leaves only via vault callback. */
export async function completeGoogleOAuth(
  input: GoogleOAuthCallback,
  context: ConnectorSecretContext,
  storeRefreshToken: (value: string) => Promise<string>,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  now = new Date(),
): Promise<{ secretRef: string; grantedScopes: string[] }> {
  const parsed = callbackSchema.safeParse(input);
  if (!parsed.success) throw new ConnectorError('OAUTH_STATE_INVALID');
  const args = parsed.data;
  const actual = createHash('sha256').update(args.state).digest();
  if (
    !Number.isFinite(now.getTime()) ||
    new Date(args.expiresAt).getTime() <= now.getTime() ||
    !timingSafeEqual(actual, Buffer.from(args.stateHash, 'hex'))
  )
    throw new ConnectorError('OAUTH_STATE_INVALID');
  secretRedactor.register(args.code);
  secretRedactor.register(args.codeVerifier);
  return useSecret(context, args.clientSecretRef, async (clientSecret) => {
    const response = await requestJson(
      new URL('https://oauth2.googleapis.com/token'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: args.code,
          code_verifier: args.codeVerifier,
          redirect_uri: args.redirectUri,
          client_id: args.clientId,
          client_secret: clientSecret,
        }).toString(),
      },
      context.signal,
      fetcher,
    );
    requireSuccess(response.status);
    const tokens = parseResponse(response.body, tokenSchema);
    secretRedactor.register(tokens.access_token);
    if (tokens.refresh_token === undefined) throw new ConnectorError('INVALID_CREDENTIAL');
    secretRedactor.register(tokens.refresh_token);
    const secretRef = await storeRefreshToken(tokens.refresh_token);
    if (!/^secret:\/\/[A-Za-z0-9_-]{1,128}$/.test(secretRef))
      throw new ConnectorError('INVALID_CREDENTIAL');
    return { secretRef, grantedScopes: tokens.scope?.split(/\s+/).filter(Boolean) ?? [] };
  });
}

/** Refresh for each execution; credentials remain inside nested execution-scoped callbacks. */
export async function withGoogleAccess<T>(
  account: ConnectorAccount,
  context: ConnectorSecretContext,
  fetcher: typeof globalThis.fetch | undefined,
  consume: (access: string) => Promise<T>,
): Promise<T> {
  const { oauthClientId, oauthClientSecretRef } = account.options;
  if (oauthClientId === undefined || oauthClientSecretRef === undefined)
    throw new ConnectorError('INVALID_CREDENTIAL');
  return useSecret(context, account.secretRef, async (refreshToken) =>
    useSecret(context, oauthClientSecretRef, async (clientSecret) => {
      const response = await requestJson(
        new URL('https://oauth2.googleapis.com/token'),
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: oauthClientId,
            client_secret: clientSecret,
          }).toString(),
        },
        context.signal,
        fetcher,
      );
      requireSuccess(response.status);
      const tokens = parseResponse(response.body, tokenSchema);
      secretRedactor.register(tokens.access_token);
      return consume(tokens.access_token);
    }),
  );
}

export const googleProviders = [
  'gmail',
  'google-calendar',
  'google-drive',
  'google-sheets',
  'google-docs',
];
const googleScopeMap: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  gmail: {
    'email:read': 'gmail.readonly',
    'email:draft': 'gmail.compose',
    'email:send': 'gmail.send',
  },
  'google-calendar': {
    'calendar:read': 'calendar.events.readonly',
    'calendar:write': 'calendar.events',
    'calendar:delete': 'calendar.events',
  },
  'google-drive': { 'drive:read': 'drive.readonly', 'drive:write': 'drive.file' },
  'google-sheets': { 'sheets:read': 'spreadsheets.readonly', 'sheets:write': 'spreadsheets' },
  'google-docs': { 'docs:read': 'documents.readonly', 'docs:write': 'documents' },
};
export const microsoftScopeMap: Readonly<Record<string, string>> = {
  'outlook:read': 'Mail.Read',
  'outlook:send': 'Mail.Send',
  'graph-calendar:read': 'Calendars.Read',
  'graph-calendar:write': 'Calendars.ReadWrite',
  'graph-calendar:delete': 'Calendars.ReadWrite',
  'onedrive:read': 'Files.Read',
  'onedrive:write': 'Files.ReadWrite',
};
export function requestedOAuthScopes(account: ConnectorAccount): string[] {
  const microsoft = account.provider === 'microsoft-graph';
  const prefix = microsoft ? '' : 'https://www.googleapis.com/auth/';
  const map = microsoft ? microsoftScopeMap : googleScopeMap[account.provider ?? ''];
  if (!map) throw new ConnectorError('OAUTH_STATE_INVALID');
  const allowed = new Set(Object.values(map).map((scope) => prefix + scope));
  if (account.provider === 'gmail') allowed.add(prefix + 'gmail.modify');
  if (account.provider === 'google-calendar') allowed.add(prefix + 'calendar.readonly');
  const scopes = account.scopes
    .filter((scope) => scope !== 'offline_access')
    .map((scope) => (map[scope] ? prefix + map[scope] : scope));
  if (
    !scopes.length ||
    scopes.some(
      (scope) =>
        !allowed.has(scope) ||
        (account.mode === 'read' &&
          !(microsoft ? scope.endsWith('.Read') : scope.endsWith('.readonly'))),
    )
  )
    throw new ConnectorError('OAUTH_STATE_INVALID');
  return [...new Set(scopes)];
}
const tenant = z.string().regex(/^(?:common|organizations|consumers|[a-fA-F0-9-]{36})$/);
export function createMicrosoftOAuthRequest(
  input: { clientId: string; redirectUri: string; scopes: string[]; tenantId?: string },
  now = new Date(),
): GoogleOAuthAttempt {
  const parsed = z
    .strictObject({
      clientId: z.string().min(1).max(300),
      redirectUri: redirectSchema,
      scopes: z
        .array(z.string().refine((scope) => Object.values(microsoftScopeMap).includes(scope)))
        .min(1)
        .max(10),
      tenantId: tenant.default('common'),
    })
    .parse(input);
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(48).toString('base64url');
  const url = new URL(`https://login.microsoftonline.com/${parsed.tenantId}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: parsed.clientId,
    redirect_uri: parsed.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: ['offline_access', ...parsed.scopes].join(' '),
    state,
    code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  return {
    authorizationUrl: url.href,
    stateHash: createHash('sha256').update(state).digest('hex'),
    codeVerifier,
    expiresAt: new Date(now.getTime() + 600_000).toISOString(),
  };
}
export async function completeMicrosoftOAuth(
  input: GoogleOAuthCallback & { tenantId?: string },
  context: ConnectorSecretContext,
  storeRefreshToken: (value: string) => Promise<string>,
  fetcher: typeof fetch = fetch,
  now = new Date(),
) {
  const { tenantId, ...callback } = input;
  const args = callbackSchema.parse(callback);
  if (
    new Date(args.expiresAt).getTime() <= now.getTime() ||
    !timingSafeEqual(
      createHash('sha256').update(args.state).digest(),
      Buffer.from(args.stateHash, 'hex'),
    )
  )
    throw new ConnectorError('OAUTH_STATE_INVALID');
  secretRedactor.register(args.code);
  secretRedactor.register(args.codeVerifier);
  return useSecret(context, args.clientSecretRef, async (clientSecret) => {
    const response = await requestJson(
      new URL(
        `https://login.microsoftonline.com/${tenant.parse(tenantId ?? 'common')}/oauth2/v2.0/token`,
      ),
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: args.code,
          code_verifier: args.codeVerifier,
          redirect_uri: args.redirectUri,
          client_id: args.clientId,
          client_secret: clientSecret,
        }).toString(),
      },
      context.signal,
      fetcher,
    );
    requireSuccess(response.status);
    const tokens = parseResponse(response.body, tokenSchema);
    secretRedactor.register(tokens.access_token);
    if (!tokens.refresh_token) throw new ConnectorError('INVALID_CREDENTIAL');
    secretRedactor.register(tokens.refresh_token);
    const secretRef = await storeRefreshToken(tokens.refresh_token);
    if (!/^secret:\/\/[A-Za-z0-9_-]{1,128}$/.test(secretRef))
      throw new ConnectorError('INVALID_CREDENTIAL');
    return { secretRef, grantedScopes: tokens.scope?.split(/\s+/).filter(Boolean) ?? [] };
  });
}
export async function withMicrosoftAccess<T>(
  account: ConnectorAccount,
  context: ConnectorSecretContext,
  fetcher: typeof fetch | undefined,
  consume: (access: string) => Promise<T>,
): Promise<T> {
  if (!account.options.oauthClientId || !account.options.oauthClientSecretRef)
    throw new ConnectorError('INVALID_CREDENTIAL');
  return useSecret(context, account.secretRef, (refresh) =>
    useSecret(context, account.options.oauthClientSecretRef!, async (clientSecret) => {
      const response = await requestJson(
        new URL(
          `https://login.microsoftonline.com/${tenant.parse(account.options.tenantId ?? 'common')}/oauth2/v2.0/token`,
        ),
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refresh,
            client_id: account.options.oauthClientId!,
            client_secret: clientSecret,
            scope: ['offline_access', ...requestedOAuthScopes(account)].join(' '),
          }).toString(),
        },
        context.signal,
        fetcher,
      );
      requireSuccess(response.status);
      const tokens = parseResponse(response.body, tokenSchema);
      secretRedactor.register(tokens.access_token);
      if (tokens.refresh_token) secretRedactor.register(tokens.refresh_token);
      return consume(tokens.access_token);
    }),
  );
}
