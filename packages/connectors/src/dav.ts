import { z } from 'zod';
import type { ConnectorDependencies, ConnectorAccount } from './contracts.js';
import { requiredOption } from './native-http.js';
import { boundedText, nativeAccount, nativeTool } from './native-tools.js';
import { ConnectorError } from './errors.js';

function target(account: ConnectorAccount, name = '') {
  const url = new URL(requiredOption(account, 'baseUrl'));
  if (!url.pathname.endsWith('/')) throw new ConnectorError('ACCOUNT_UNAVAILABLE');
  return `${url.href}${encodeURIComponent(name)}`;
}
const etag = z
  .string()
  .min(3)
  .max(300)
  .regex(/^(?:W\/)?"[^"\r\n]+"$/);
const output = z.strictObject({
  text: z.string().max(262144),
  etag: z.string().max(300).nullable(),
});
export function createDavTools(dependencies: ConnectorDependencies) {
  return (['caldav', 'carddav'] as const).flatMap((provider) => {
    const resource = z
      .string()
      .min(5)
      .max(150)
      .regex(
        provider === 'caldav'
          ? /^[A-Za-z0-9][A-Za-z0-9_-]*\.ics$/
          : /^[A-Za-z0-9][A-Za-z0-9_-]*\.vcf$/,
      );
    return [
      nativeTool(dependencies, {
        provider,
        permission: `${provider}:read`,
        name: `${provider}.list`,
        effect: 'read',
        description: `List the configured ${provider} collection with Depth 1.`,
        input: nativeAccount,
        response: output,
        request: (_context, account, _args, call) =>
          call(target(account), {
            custom: true,
            method: 'PROPFIND',
            headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
            text: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getetag/><d:resourcetype/></d:prop></d:propfind>',
          }),
      }),
      nativeTool(dependencies, {
        provider,
        permission: `${provider}:read`,
        name: `${provider}.read`,
        effect: 'read',
        description: `Read one named resource inside the configured ${provider} collection.`,
        input: nativeAccount.extend({ resource }),
        response: output,
        request: (_context, account, args, call) =>
          call(target(account, args.resource), { custom: true }),
      }),
      nativeTool(dependencies, {
        provider,
        permission: `${provider}:write`,
        name: `${provider}.write`,
        effect: 'write',
        description: `Create or conditionally replace an item in the configured ${provider} collection.`,
        input: nativeAccount.extend({
          resource,
          text: boundedText,
          etag: etag.nullable().default(null),
        }),
        response: output,
        request: (_context, account, args, call) => {
          const kind = provider === 'caldav' ? 'VCALENDAR' : 'VCARD';
          if (
            !args.text.startsWith(`BEGIN:${kind}`) ||
            !args.text.trimEnd().endsWith(`END:${kind}`)
          )
            throw new ConnectorError('REQUEST_REJECTED');
          // Scheduling invitations are a send effect and are not part of this write-only adapter.
          if (provider === 'caldav' && /^(?:METHOD|ATTENDEE|ORGANIZER)[;:]/im.test(args.text))
            throw new ConnectorError('REQUEST_REJECTED');
          return call(target(account, args.resource), {
            custom: true,
            method: 'PUT',
            text: args.text,
            headers: {
              'content-type':
                provider === 'caldav'
                  ? 'text/calendar; charset=utf-8'
                  : 'text/vcard; charset=utf-8',
              ...(args.etag ? { 'if-match': args.etag } : { 'if-none-match': '*' }),
            },
          });
        },
      }),
      nativeTool(dependencies, {
        provider,
        permission: `${provider}:delete`,
        name: `${provider}.delete`,
        effect: 'delete',
        description: `Delete a named ${provider} item only if its current ETag matches.`,
        input: nativeAccount.extend({ resource, etag }),
        response: output,
        request: (_context, account, args, call) =>
          call(target(account, args.resource), {
            custom: true,
            method: 'DELETE',
            headers: { 'if-match': args.etag },
          }),
      }),
    ];
  });
}
