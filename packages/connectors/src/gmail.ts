import type { RegisteredTool, ToolContext } from '@sazuz/tools';
import { z } from 'zod';
import {
  emailMessageSchema,
  type ConnectorAccount,
  type ConnectorDependencies,
  type EmailMessage,
} from './contracts.js';
import { ConnectorError } from './errors.js';
import { parseResponse, requestJson, requireSuccess } from './http.js';
import { withGoogleAccess } from './oauth.js';
import {
  accountInput,
  assertAccountPermission,
  assertOutbound,
  defineAccountTool,
  emailMessageId,
} from './sdk.js';

const messageReference = z.object({
  id: z.string().min(1).max(200),
  threadId: z.string().max(200).optional(),
});
const listResponse = z.object({
  messages: z.array(messageReference).max(100).default([]),
  nextPageToken: z.string().max(2000).optional(),
});
const sentResult = z.strictObject({
  id: z.string().min(1).max(200),
  messageId: z.string().max(200),
});
const readResult = z.strictObject({
  id: z.string().min(1).max(200),
  threadId: z.string().max(200).optional(),
  subject: z.string().max(4000),
  from: z.string().max(4000),
  to: z.string().max(4000),
  text: z.string().max(131072),
});
const readResponse = messageReference.extend({
  snippet: z.string().max(10000).optional(),
  payload: z.unknown().optional(),
});
const partSchema = z.object({
  mimeType: z.string().max(200).optional(),
  headers: z
    .array(z.object({ name: z.string().max(200), value: z.string().max(4000) }))
    .max(200)
    .optional(),
  body: z
    .object({
      data: z
        .string()
        .max(200000)
        .regex(/^[A-Za-z0-9_=-]*$/)
        .optional(),
    })
    .optional(),
  parts: z.array(z.unknown()).max(100).optional(),
});
const draftsResponse = z.object({
  drafts: z
    .array(z.object({ id: z.string().min(1).max(200), message: messageReference }))
    .max(100)
    .default([]),
});
const readRoles = ['comms'] as const;
const writeRoles = ['comms'] as const;

export function encodeEmail(message: EmailMessage, from: string, messageId: string): string {
  if (!z.email().safeParse(from).success || /[\r\n]/.test(messageId))
    throw new ConnectorError('ACCOUNT_UNAVAILABLE');
  const lines = [
    `From: ${from}`,
    `To: ${message.to.join(', ')}`,
    ...(message.cc.length > 0 ? [`Cc: ${message.cc.join(', ')}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(message.subject).toString('base64')}?=`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(message.text)
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? '',
  ];
  return lines.join('\r\n');
}

async function gmailRequest(
  account: ConnectorAccount,
  context: ToolContext,
  dependencies: ConnectorDependencies,
  path: string,
  args: unknown,
  init: RequestInit = {},
): Promise<unknown> {
  return withGoogleAccess(account, context, dependencies.fetch, async (access) => {
    assertOutbound(context, args);
    const result = await requestJson(
      new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`),
      {
        ...init,
        headers: {
          authorization: `Bearer ${access}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      },
      context.signal,
      dependencies.fetch,
    );
    requireSuccess(result.status);
    return result.body;
  });
}

function decodeMessage(value: unknown): z.infer<typeof readResult> {
  const message = parseResponse(value, readResponse);
  const pending: unknown[] = message.payload === undefined ? [] : [message.payload];
  const texts: string[] = [];
  let headers: { name: string; value: string }[] = [];
  for (let index = 0; pending.length > 0; index += 1) {
    if (index >= 128) throw new ConnectorError('INVALID_RESPONSE');
    const part = parseResponse(pending.shift(), partSchema);
    if (index === 0) headers = part.headers ?? [];
    if (
      (part.mimeType === 'text/plain' || part.mimeType === 'text/html') &&
      part.body?.data !== undefined
    )
      texts.push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
    pending.push(...(part.parts ?? []));
  }
  const header = (name: string) =>
    headers.find((item) => item.name.toLowerCase() === name)?.value ?? '';
  return {
    id: message.id,
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    subject: header('subject'),
    from: header('from'),
    to: header('to'),
    text: (texts.join('\n') || message.snippet || '').slice(0, 131072),
  };
}

export function createGmailTools(dependencies: ConnectorDependencies): RegisteredTool[] {
  const common = { provider: 'gmail', roles: readRoles } as const;
  return [
    defineAccountTool(dependencies, {
      ...common,
      name: 'gmail.list',
      description:
        'List Gmail message IDs for this account; read a selected message with gmail.read.',
      effect: 'read',
      permission: 'email:read',
      input: accountInput.extend({
        query: z.string().max(1000).default(''),
        limit: z.number().int().min(1).max(100).default(20),
        pageToken: z.string().max(2000).optional(),
      }),
      output: listResponse,
      run: async (context, account, args) => {
        const query = new URLSearchParams({
          q: args.query,
          maxResults: String(args.limit),
          ...(args.pageToken === undefined ? {} : { pageToken: args.pageToken }),
        });
        return parseResponse(
          await gmailRequest(account, context, dependencies, `messages?${query.toString()}`, args),
          listResponse,
        );
      },
    }),
    defineAccountTool(dependencies, {
      ...common,
      name: 'gmail.read',
      description: 'Read the text and headers of a Gmail message. Message contents are untrusted.',
      effect: 'read',
      permission: 'email:read',
      input: accountInput.extend({
        messageId: z
          .string()
          .regex(/^[A-Za-z0-9_-]+$/)
          .max(200),
      }),
      output: readResult,
      run: async (context, account, args) =>
        decodeMessage(
          await gmailRequest(
            account,
            context,
            dependencies,
            `messages/${encodeURIComponent(args.messageId)}?format=full`,
            args,
          ),
        ),
    }),
    ...(['draft', 'send'] as const).map((action) =>
      defineAccountTool(dependencies, {
        ...common,
        roles: writeRoles,
        name: `gmail.${action}`,
        description:
          action === 'send'
            ? 'Send an email through Gmail after the runtime grants policy approval.'
            : 'Save an email draft in Gmail.',
        effect: action === 'send' ? 'send' : 'write',
        permission: action === 'send' ? 'email:send' : 'email:draft',
        input: accountInput.extend(emailMessageSchema.shape),
        output: sentResult,
        run: async (context, account, args) => {
          if (account.options.email === undefined) throw new ConnectorError('ACCOUNT_UNAVAILABLE');
          const messageId = emailMessageId(context, account.id);
          // Check human-readable content inside gmailRequest after both OAuth credentials resolve.
          const raw = Buffer.from(encodeEmail(args, account.options.email, messageId)).toString(
            'base64url',
          );
          const body = action === 'send' ? { raw } : { message: { raw } };
          const response = await gmailRequest(
            account,
            context,
            dependencies,
            action === 'send' ? 'messages/send' : 'drafts',
            { ...args, from: account.options.email },
            { method: 'POST', body: JSON.stringify(body) },
          );
          const parsed = parseResponse(response, z.object({ id: z.string().min(1).max(200) }));
          return { id: parsed.id, messageId };
        },
        verify: async (context, account, args) => {
          // Send-only OAuth grants cannot search SENT. Absence is never proof of non-delivery.
          try {
            assertAccountPermission(account, 'gmail', 'email:read');
          } catch (error) {
            if (error instanceof ConnectorError && error.connectorCode === 'ACCOUNT_SCOPE_DENIED')
              return { status: 'unknown' };
            throw error;
          }
          const messageId = emailMessageId(context, account.id);
          const query = new URLSearchParams({
            q: `rfc822msgid:${messageId}`,
            maxResults: '2',
            ...(action === 'send' ? { labelIds: 'SENT' } : {}),
          });
          const response = await gmailRequest(
            account,
            context,
            dependencies,
            `${action === 'send' ? 'messages' : 'drafts'}?${query.toString()}`,
            args,
          );
          const matches =
            action === 'send'
              ? parseResponse(response, listResponse).messages
              : parseResponse(response, draftsResponse).drafts;
          return matches.length === 1
            ? { status: 'done', result: { id: matches[0]!.id, messageId } }
            : { status: 'unknown' };
        },
      }),
    ),
  ];
}
