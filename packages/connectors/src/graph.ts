import { z } from 'zod';
import type { ConnectorDependencies } from './contracts.js';
import { ConnectorError } from './errors.js';
import { optionPath, requiredOption } from './native-http.js';
import {
  boundedText,
  jsonRecord,
  nativeAccount,
  nativeId,
  nativeLimit,
  nativeTool,
} from './native-tools.js';

const root = 'https://graph.microsoft.com/v1.0';
const collection = z.object({
  value: z.array(jsonRecord).max(1000),
  '@odata.nextLink': z.string().optional(),
});
const date = z.strictObject({
  dateTime: z.iso.datetime(),
  timeZone: z.literal('UTC').default('UTC'),
});
export function createGraphTools(dependencies: ConnectorDependencies) {
  const common = { provider: 'microsoft-graph' } as const;
  return [
    nativeTool(dependencies, {
      ...common,
      permission: 'outlook:read',
      name: 'outlook.list',
      effect: 'read',
      description: 'List mail in the configured Outlook folder.',
      input: nativeAccount.extend({ limit: nativeLimit }),
      response: collection,
      request: (_context, account, args, call) =>
        call(
          `${root}/me/mailFolders/${encodeURIComponent(account.options.mailFolderId ?? 'inbox')}/messages?$top=${args.limit}&$select=id,subject,from,receivedDateTime,bodyPreview`,
        ),
    }),
    nativeTool(dependencies, {
      ...common,
      permission: 'outlook:send',
      name: 'outlook.send',
      effect: 'send',
      description: 'Send a plain-text message from the connected Microsoft mailbox.',
      input: nativeAccount.extend({
        to: z.array(z.email()).min(1).max(20),
        subject: z.string().min(1).max(998),
        text: boundedText,
      }),
      response: z.null(),
      request: (_context, _account, args, call) =>
        call(`${root}/me/sendMail`, {
          method: 'POST',
          json: {
            message: {
              subject: args.subject,
              body: { contentType: 'Text', content: args.text },
              toRecipients: args.to.map((address) => ({ emailAddress: { address } })),
            },
            saveToSentItems: true,
          },
        }),
    }),
    nativeTool(dependencies, {
      ...common,
      permission: 'graph-calendar:read',
      name: 'graph_calendar.list',
      effect: 'read',
      description: 'List events on the configured Microsoft calendar.',
      input: nativeAccount.extend({ limit: nativeLimit }),
      response: collection,
      request: (_context, account, args, call) =>
        call(`${root}/me/calendars/${optionPath(account, 'calendarId')}/events?$top=${args.limit}`),
    }),
    nativeTool(dependencies, {
      ...common,
      permission: 'graph-calendar:write',
      name: 'graph_calendar.create',
      effect: 'write',
      description: 'Create an event on the configured Microsoft calendar.',
      input: nativeAccount
        .extend({ subject: z.string().min(1).max(500), start: date, end: date })
        .refine((args) => args.end.dateTime > args.start.dateTime),
      response: jsonRecord,
      request: (context, account, args, call) =>
        call(`${root}/me/calendars/${optionPath(account, 'calendarId')}/events`, {
          method: 'POST',
          json: {
            subject: args.subject,
            start: args.start,
            end: args.end,
            transactionId: context.idempotencyKey,
          },
        }),
    }),
    nativeTool(dependencies, {
      ...common,
      permission: 'graph-calendar:delete',
      name: 'graph_calendar.delete',
      effect: 'delete',
      description: 'Delete an event only from the configured Microsoft calendar.',
      input: nativeAccount.extend({ eventId: nativeId }),
      response: z.null(),
      request: (_context, account, args, call) =>
        call(
          `${root}/me/calendars/${optionPath(account, 'calendarId')}/events/${encodeURIComponent(args.eventId)}`,
          { method: 'DELETE' },
        ),
    }),
    nativeTool(dependencies, {
      ...common,
      permission: 'onedrive:read',
      name: 'onedrive.list',
      effect: 'read',
      description: 'List items directly inside the configured OneDrive folder.',
      input: nativeAccount.extend({ limit: nativeLimit }),
      response: collection,
      request: (_context, account, args, call) =>
        call(
          `${root}/drives/${optionPath(account, 'driveId')}/items/${optionPath(account, 'folderId')}/children?$top=${args.limit}`,
        ),
    }),
    nativeTool(dependencies, {
      ...common,
      permission: 'onedrive:read',
      name: 'onedrive.read',
      effect: 'read',
      description: 'Read metadata for an item in the configured OneDrive folder.',
      input: nativeAccount.extend({ itemId: nativeId }),
      response: jsonRecord,
      request: async (_context, account, args, call) => {
        const value = z
          .object({
            id: z.string(),
            name: z.string(),
            parentReference: z.object({ id: z.string(), driveId: z.string() }),
          })
          .passthrough()
          .parse(
            await call(
              `${root}/drives/${optionPath(account, 'driveId')}/items/${encodeURIComponent(args.itemId)}`,
            ),
          );
        if (
          value.parentReference.id !== requiredOption(account, 'folderId') ||
          value.parentReference.driveId !== requiredOption(account, 'driveId')
        )
          throw new ConnectorError('ACCOUNT_SCOPE_DENIED');
        // Download URLs are temporary capabilities; never expose them to model context.
        delete value['@microsoft.graph.downloadUrl'];
        return value;
      },
    }),
    nativeTool(dependencies, {
      ...common,
      permission: 'onedrive:write',
      name: 'onedrive.write',
      effect: 'write',
      description: 'Write a UTF-8 text file inside the configured OneDrive folder.',
      input: nativeAccount.extend({
        name: z
          .string()
          .min(1)
          .max(120)
          .regex(/^[A-Za-z0-9][A-Za-z0-9_. -]*\.txt$/),
        text: boundedText,
      }),
      response: jsonRecord,
      request: (_context, account, args, call) =>
        call(
          `${root}/drives/${optionPath(account, 'driveId')}/items/${optionPath(account, 'folderId')}:/${encodeURIComponent(args.name)}:/content`,
          {
            method: 'PUT',
            text: args.text,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          },
        ),
    }),
  ];
}
