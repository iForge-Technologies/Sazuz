import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import {
  completeGoogleOAuth,
  completeMicrosoftOAuth,
  connectorAccountSchema,
  createGoogleOAuthRequest,
  createMicrosoftOAuthRequest,
  googleProviders,
  requestedOAuthScopes,
  type ConnectorAccount,
} from '@sazuz/connectors';
import { auditLog, oauthStates, readSettings, saveSetting, valueHash, workKey } from '@sazuz/db';
import { secretRedactor, type SecretReference } from '@sazuz/vault';
import type { createApp } from './app.js';
import { tokenHash, type PhaseOne } from './phase-one.js';
import { RequestError } from './phase-one-errors.js';
import { accountPath, parseRequest } from './phase-three-shared.js';

const startInput = z.strictObject({ version: z.number().int().positive() });
const callbackInput = z.strictObject({
  state: z.string().min(20).max(200),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(2000).optional(),
  error_uri: z.string().max(2000).optional(),
  scope: z.string().max(4096).optional(),
  authuser: z.string().max(100).optional(),
  prompt: z.string().max(100).optional(),
});
const verifierInput = z.strictObject({
  codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  version: z.number().int().positive(),
  accountHash: z.string().regex(/^[a-f0-9]{64}$/),
  scopes: z.array(z.string().max(200)).min(1).max(10),
});
const unavailable = () =>
  new RequestError(
    'OAUTH_CONFIGURATION_INVALID',
    400,
    'Configure this account, requested scopes, client ID, client secret and callback URL before connecting.',
  );

function requestedScopes(account: ConnectorAccount): string[] {
  try {
    return requestedOAuthScopes(account);
  } catch {
    throw unavailable();
  }
}

function googleAccount(accounts: unknown[], id: string, provider: 'google' | 'microsoft') {
  const parsed = z.array(connectorAccountSchema).safeParse(accounts);
  if (!parsed.success) throw unavailable();
  const matches = parsed.data.filter((account) => account.id === id);
  const account = matches[0];
  if (
    matches.length !== 1 ||
    !account ||
    !(provider === 'google' ? googleProviders : ['microsoft-graph']).includes(
      account.provider ?? '',
    ) ||
    !account.options.oauthClientId ||
    !account.options.oauthClientSecretRef
  )
    throw unavailable();
  return account;
}

export function registerGoogleOAuth(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  options: { fetch?: typeof fetch } = {},
) {
  registerOAuth(app, runtime, options, 'google');
  registerOAuth(app, runtime, options, 'microsoft');
}

function registerOAuth(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  options: { fetch?: typeof fetch },
  provider: 'google' | 'microsoft',
) {
  const { database, vault } = runtime;
  app.post(`/api/connectors/:id/oauth/${provider}/start`, async (request) => {
    const { user } = await runtime.admin(request);
    const { id } = parseRequest(accountPath, request.params);
    const input = parseRequest(startInput, request.body);
    await runtime.rateLimit(`oauth-start:${user.id}`, 10);
    const settings = await readSettings(database);
    if (settings.connectors.version !== input.version)
      throw new RequestError(
        'SETTINGS_CONFLICT',
        409,
        'Connector settings changed. Reload before connecting.',
      );
    const account = googleAccount(settings.connectors.value.accounts, id, provider);
    const expected = new URL(
      `/oauth/${provider}/callback`,
      settings.general.value.baseUrl,
    ).toString();
    const redirectUri = account.options.oauthRedirectUri ?? expected;
    if (redirectUri !== expected) throw unavailable();
    const scopes = requestedScopes(account);
    const attempt = (
      provider === 'google' ? createGoogleOAuthRequest : createMicrosoftOAuthRequest
    )({
      clientId: account.options.oauthClientId!,
      redirectUri,
      scopes,
      ...(provider === 'microsoft' && account.options.tenantId
        ? { tenantId: account.options.tenantId }
        : {}),
    });
    secretRedactor.register(attempt.codeVerifier);
    const secret = await vault.create({
      name: `${provider} OAuth verifier ${id}`,
      value: JSON.stringify({
        codeVerifier: attempt.codeVerifier,
        version: input.version,
        accountHash: valueHash(account),
        scopes,
      }),
      createdBy: user.id,
    });
    try {
      await database.orm.insert(oauthStates).values({
        stateHash: attempt.stateHash,
        provider,
        userId: user.id,
        accountId: id,
        verifierRef: secret.reference,
        redirectUri,
        expiresAt: new Date(attempt.expiresAt),
      });
      await database.orm.insert(auditLog).values({
        id: workKey('aud'),
        actorId: user.id,
        action: `oauth.${provider}.started`,
        target: id,
      });
    } catch (error) {
      try {
        await vault.delete(secret.id);
      } catch {
        database.logger.warn(
          { code: 'OAUTH_VERIFIER_CLEANUP_FAILED' },
          'An unused OAuth verifier remains encrypted in the vault.',
        );
      }
      throw error;
    }
    return { authorizationUrl: attempt.authorizationUrl, expiresAt: attempt.expiresAt };
  });

  app.get(`/oauth/${provider}/callback`, async (request, reply) => {
    let verifierId: string | undefined;
    let refreshId: string | undefined;
    let saved = false;
    try {
      const { user } = await runtime.admin(request);
      const input = parseRequest(callbackInput, request.query);
      await runtime.rateLimit(`oauth-callback:${user.id}`, 30);
      // Consuming before exchange makes even concurrent callbacks a single attempt.
      const [attempt] = await database.orm
        .delete(oauthStates)
        .where(
          and(
            eq(oauthStates.stateHash, tokenHash(input.state)),
            eq(oauthStates.provider, provider),
            eq(oauthStates.userId, user.id),
            gt(oauthStates.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!attempt) throw unavailable();
      verifierId = attempt.verifierRef.slice('secret://'.length);
      if (!input.code || input.error) throw unavailable();
      const settings = await readSettings(database);
      const account = googleAccount(
        settings.connectors.value.accounts,
        attempt.accountId,
        provider,
      );
      const clientSecretRef = account.options.oauthClientSecretRef!;
      const result = await vault.withSecrets(
        [attempt.verifierRef as SecretReference, clientSecretRef as SecretReference],
        async (values, store) => {
          const verifier = verifierInput.parse(
            JSON.parse(values.get(attempt.verifierRef)!) as unknown,
          );
          if (
            verifier.version !== settings.connectors.version ||
            verifier.accountHash !== valueHash(account)
          )
            throw unavailable();
          const completed = await (
            provider === 'google' ? completeGoogleOAuth : completeMicrosoftOAuth
          )(
            {
              state: input.state,
              stateHash: attempt.stateHash,
              codeVerifier: verifier.codeVerifier,
              expiresAt: attempt.expiresAt.toISOString(),
              code: input.code!,
              clientId: account.options.oauthClientId!,
              clientSecretRef,
              redirectUri: attempt.redirectUri,
              ...(provider === 'microsoft' && account.options.tenantId
                ? { tenantId: account.options.tenantId }
                : {}),
            },
            {
              signal: AbortSignal.timeout(30_000),
              secret: async (reference, consume) => {
                if (reference !== clientSecretRef) throw unavailable();
                const secret = values.get(reference);
                if (!secret) throw unavailable();
                return consume(secret);
              },
            },
            async (value) => {
              const token = await store({
                name: `${provider} refresh token ${account.id}`,
                value,
                createdBy: user.id,
              });
              refreshId = token.id;
              return token.reference;
            },
            options.fetch,
          );
          const granted = completed.grantedScopes.length
            ? completed.grantedScopes
            : verifier.scopes;
          const scopes = verifier.scopes.filter((scope) => granted.includes(scope));
          if (!scopes.length) throw unavailable();
          return { secretRef: completed.secretRef, scopes };
        },
      );
      await saveSetting(database, {
        namespace: 'connectors',
        actorId: user.id,
        expectedVersion: settings.connectors.version,
        value: {
          accounts: settings.connectors.value.accounts.map((item) =>
            item.id === account.id
              ? { ...item, secretRef: result.secretRef, scopes: result.scopes }
              : item,
          ),
        },
      });
      saved = true;
      return reply.redirect('/settings?section=connectors&oauth=connected', 303);
    } catch {
      database.logger.warn(
        { code: 'OAUTH_CALLBACK_FAILED' },
        'Account authorization could not be completed.',
      );
      return reply.redirect('/settings?section=connectors&oauth=failed', 303);
    } finally {
      if (verifierId)
        try {
          await vault.delete(verifierId);
        } catch {
          database.logger.warn(
            { code: 'OAUTH_VERIFIER_CLEANUP_FAILED' },
            'An expired OAuth verifier remains encrypted in the vault.',
          );
        }
      if (refreshId && !saved)
        try {
          await vault.delete(refreshId);
        } catch {
          database.logger.warn(
            { code: 'OAUTH_TOKEN_CLEANUP_FAILED' },
            'An unused OAuth token remains encrypted in the vault.',
          );
        }
    }
  });
}
