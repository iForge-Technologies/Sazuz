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

const file = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  parents: z.array(z.string()).optional(),
});
const range = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^(?:'[^'\r\n]+'|[A-Za-z0-9_ -]+)!\$?[A-Z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Z]{1,3}\$?[1-9]\d{0,6})?$/,
  );
export function createGoogleWorkspaceTools(dependencies: ConnectorDependencies) {
  return [
    nativeTool(dependencies, {
      provider: 'google-drive',
      permission: 'drive:read',
      name: 'drive.list',
      effect: 'read',
      description: 'List metadata for files directly inside the configured Google Drive folder.',
      input: nativeAccount.extend({ limit: nativeLimit }),
      response: z.object({ files: z.array(file).max(100), nextPageToken: z.string().optional() }),
      request: (_context, account, args, call) =>
        call(
          `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q: `'${requiredOption(account, 'folderId')}' in parents and trashed = false`, pageSize: String(args.limit), fields: 'files(id,name,mimeType,parents),nextPageToken' }).toString()}`,
        ),
    }),
    nativeTool(dependencies, {
      provider: 'google-drive',
      permission: 'drive:read',
      name: 'drive.read',
      effect: 'read',
      description:
        'Read a file’s metadata after verifying membership in the configured Drive folder.',
      input: nativeAccount.extend({ fileId: nativeId }),
      response: file,
      request: async (_context, account, args, call) => {
        const value = file.parse(
          await call(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(args.fileId)}?fields=id,name,mimeType,parents`,
          ),
        );
        if (!value.parents?.includes(requiredOption(account, 'folderId')))
          throw new ConnectorError('ACCOUNT_SCOPE_DENIED');
        return value;
      },
    }),
    nativeTool(dependencies, {
      provider: 'google-drive',
      permission: 'drive:write',
      name: 'drive.create_folder',
      effect: 'write',
      description: 'Create a folder beneath the configured Google Drive folder.',
      input: nativeAccount.extend({ name: z.string().min(1).max(200) }),
      response: file,
      request: (_context, account, args, call) =>
        call('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,parents', {
          method: 'POST',
          json: {
            name: args.name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [requiredOption(account, 'folderId')],
          },
        }),
    }),
    nativeTool(dependencies, {
      provider: 'google-sheets',
      permission: 'sheets:read',
      name: 'sheets.read',
      effect: 'read',
      description: 'Read an A1 range from the one spreadsheet configured on this account.',
      input: nativeAccount.extend({ range }),
      response: z.object({
        range: z.string(),
        majorDimension: z.string().optional(),
        values: z
          .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
          .max(10000)
          .optional(),
      }),
      request: (_context, account, args, call) =>
        call(
          `https://sheets.googleapis.com/v4/spreadsheets/${optionPath(account, 'spreadsheetId')}/values/${encodeURIComponent(args.range)}?valueRenderOption=UNFORMATTED_VALUE`,
        ),
    }),
    nativeTool(dependencies, {
      provider: 'google-sheets',
      permission: 'sheets:write',
      name: 'sheets.write',
      effect: 'write',
      description:
        'Write literal values to an A1 range in the configured spreadsheet; formulas are not evaluated.',
      input: nativeAccount.extend({
        range,
        values: z
          .array(
            z
              .array(z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.null()]))
              .max(50),
          )
          .min(1)
          .max(500),
      }),
      response: jsonRecord,
      request: (_context, account, args, call) =>
        call(
          `https://sheets.googleapis.com/v4/spreadsheets/${optionPath(account, 'spreadsheetId')}/values/${encodeURIComponent(args.range)}?valueInputOption=RAW`,
          {
            method: 'PUT',
            json: { range: args.range, majorDimension: 'ROWS', values: args.values },
          },
        ),
    }),
    nativeTool(dependencies, {
      provider: 'google-docs',
      permission: 'docs:read',
      name: 'docs.read',
      effect: 'read',
      description: 'Read the configured Google document.',
      input: nativeAccount,
      response: z.object({
        documentId: z.string(),
        title: z.string().optional(),
        body: jsonRecord.optional(),
        tabs: z.array(jsonRecord).optional(),
        revisionId: z.string().optional(),
      }),
      request: (_context, account, _args, call) =>
        call(`https://docs.googleapis.com/v1/documents/${optionPath(account, 'documentId')}`),
    }),
    nativeTool(dependencies, {
      provider: 'google-docs',
      permission: 'docs:write',
      name: 'docs.append',
      effect: 'write',
      description: 'Append text to the configured document at an explicitly supplied revision.',
      input: nativeAccount.extend({ text: boundedText, revisionId: z.string().min(1).max(500) }),
      response: jsonRecord,
      request: (_context, account, args, call) =>
        call(
          `https://docs.googleapis.com/v1/documents/${optionPath(account, 'documentId')}:batchUpdate`,
          {
            method: 'POST',
            json: {
              writeControl: { requiredRevisionId: args.revisionId },
              requests: [{ insertText: { endOfSegmentLocation: {}, text: args.text } }],
            },
          },
        ),
    }),
  ];
}
