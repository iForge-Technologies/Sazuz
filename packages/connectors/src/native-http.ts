import { z } from 'zod';
import type { ToolContext } from '@sazuz/tools';
import type { ConnectorAccount, ConnectorDependencies } from './contracts.js';
import { ConnectorError } from './errors.js';
import { assertOutbound, operationMarker, useSecret } from './sdk.js';
import { requestJson, requestScopedText, requireSuccess } from './http.js';
import { withGoogleAccess, withMicrosoftAccess } from './oauth.js';
import { secretRedactor } from '@sazuz/vault';

export const remoteJson = z
  .json()
  .refine((value) => JSON.stringify(value).length <= 262_144, 'Response too large.');
export const remoteResult = z.strictObject({ data: remoteJson });
export const recordResponse = z.record(z.string().max(200), remoteJson);
export const requiredOption = (
  account: ConnectorAccount,
  name: keyof ConnectorAccount['options'],
): string => {
  const value = account.options[name];
  if (typeof value !== 'string' || !value || value === '.' || value === '..')
    throw new ConnectorError('ACCOUNT_UNAVAILABLE');
  return value;
};
export const optionPath = (account: ConnectorAccount, name: keyof ConnectorAccount['options']) =>
  encodeURIComponent(requiredOption(account, name));

export async function nativeRequest(
  dependencies: ConnectorDependencies,
  context: ToolContext,
  account: ConnectorAccount,
  url: URL,
  args: unknown,
  init: {
    method?: string;
    json?: z.infer<typeof remoteJson>;
    text?: string;
    headers?: Record<string, string>;
    custom?: boolean;
  } = {},
): Promise<unknown> {
  const consume = async (credential: string) => {
    assertOutbound(context, args);
    const basic = ['caldav', 'carddav', 'jira'].includes(account.provider ?? '');
    const authorization = basic
      ? `Basic ${Buffer.from(`${requiredOption(account, 'username')}:${credential}`).toString('base64')}`
      : account.provider === 'discord'
        ? `Bot ${credential}`
        : account.provider === 'linear' && account.options.tokenKind !== 'oauth'
          ? credential
          : `Bearer ${credential}`;
    secretRedactor.register(authorization);
    const headers: Record<string, string> = {
      authorization,
      accept: 'application/json',
      'user-agent': 'Sazuz',
      ...(init.json === undefined ? {} : { 'content-type': 'application/json' }),
      ...(account.provider === 'notion' ? { 'notion-version': '2025-09-03' } : {}),
      ...(account.provider === 'todoist' && init.method === 'POST'
        ? { 'x-request-id': operationMarker(context, account.id).slice(0, 32) }
        : {}),
      ...init.headers,
    };
    const body = init.json === undefined ? init.text : JSON.stringify(init.json);
    if (init.custom) {
      const response = await requestScopedText(
        url,
        { method: init.method ?? 'GET', headers, ...(body === undefined ? {} : { body }) },
        context,
        dependencies.fetch,
      );
      requireSuccess(response.status);
      if (['caldav', 'carddav'].includes(account.provider ?? '')) {
        if (/<!DOCTYPE|<!ENTITY/i.test(response.text)) throw new ConnectorError('INVALID_RESPONSE');
        return { text: response.text, etag: response.etag };
      }
      try {
        return response.text ? (JSON.parse(response.text) as unknown) : null;
      } catch {
        throw new ConnectorError('INVALID_RESPONSE');
      }
    }
    const response = await requestJson(
      url,
      { method: init.method ?? 'GET', headers, ...(body === undefined ? {} : { body }) },
      context.signal,
      dependencies.fetch,
    );
    requireSuccess(response.status);
    return response.body;
  };
  return account.provider?.startsWith('google-')
    ? withGoogleAccess(account, context, dependencies.fetch, consume)
    : account.provider === 'microsoft-graph'
      ? withMicrosoftAccess(account, context, dependencies.fetch, consume)
      : useSecret(context, account.secretRef, consume);
}
