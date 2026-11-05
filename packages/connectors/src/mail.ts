import { ImapFlow, type FetchMessageObject } from 'imapflow';
import nodemailer from 'nodemailer';
import { secretRedactor } from '@sazuz/vault';
import { checkAbort, ToolError, type ToolContext, type RegisteredTool } from '@sazuz/tools';
import { z } from 'zod';
import {
  connectorAccountSchema,
  emailMessageSchema,
  mailboxMessageSchema,
  mailListingSchema,
  type ConnectorAccount,
  type ConnectorDependencies,
  type EmailMessage,
  type MailboxMessage,
  type MailListing,
} from './contracts.js';
import { ConnectorError } from './errors.js';
import { boundedOperation, parseResponse } from './http.js';
import {
  accountInput,
  assertAccountPermission,
  assertOutbound,
  defineAccountTool,
  emailMessageId,
  useSecret,
} from './sdk.js';

const mailbox = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\r\n\0]+$/);
const pollOptionsSchema = z.strictObject({
  mailbox,
  afterUid: z.number().int().nonnegative().max(4294967295),
  uidValidity: z.string().regex(/^\d+$/).max(30).nullable(),
  limit: z.number().int().min(1).max(100),
});
export type ImapPollOptions = z.infer<typeof pollOptionsSchema>;

interface MailCredentials {
  account: ConnectorAccount;
  password: string;
  signal: AbortSignal;
}

/** Trusted transport seam; password parameters are populated only inside context.secret callbacks. */
export interface MailTransport {
  list: (
    input: MailCredentials & {
      mailbox: string;
      limit: number;
      afterUid?: number;
      uidValidity?: string | null;
    },
  ) => Promise<MailListing>;
  read: (input: MailCredentials & { mailbox: string; uid: number }) => Promise<MailboxMessage>;
  send: (
    input: MailCredentials & { message: EmailMessage; messageId: string },
  ) => Promise<{ messageId: string; accepted: string[]; rejected: string[] }>;
  findSent: (
    input: MailCredentials & { mailbox: string; messageId: string },
  ) => Promise<{ uid: number } | null>;
}

async function withImap<T>(
  input: MailCredentials,
  consume: (client: ImapFlow, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { imapHost, email } = input.account.options;
  if (imapHost === undefined || email === undefined)
    throw new ConnectorError('ACCOUNT_UNAVAILABLE');
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
  checkAbort(signal);
  const secure = input.account.options.imapSecure ?? true;
  const client = new ImapFlow({
    host: imapHost,
    port: input.account.options.imapPort ?? (secure ? 993 : 143),
    secure,
    doSTARTTLS: !secure,
    auth: { user: email, pass: input.password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    logger: false,
    logRaw: false,
    emitLogs: false,
    disableAutoIdle: true,
    disableCompression: true,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    maxLineLength: 65536,
    maxLiteralSize: 131072,
    maxResponseSize: 262144,
    maxResponseTokens: 10000,
  });
  let failed = false;
  const onError = () => {
    failed = true;
    client.close();
  };
  const onAbort = () => client.close();
  client.on('error', onError);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await boundedOperation(client.connect(), signal);
    const result = await boundedOperation(consume(client, signal), signal);
    if (failed) throw new ConnectorError('TRANSPORT_FAILED');
    return result;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ConnectorError('TRANSPORT_FAILED');
  } finally {
    signal.removeEventListener('abort', onAbort);
    client.close();
    // Keep the safe listener on the now-closed object for delayed socket errors.
  }
}

/** Bounded MIME text extraction; attachments stay unread and all text remains untrusted. */
function mimeText(source: string, depth = 0): string {
  if (depth > 8) return '';
  const split = /\r?\n\r?\n/.exec(source);
  if (split === null) return source.slice(0, 131072);
  const headers = source.slice(0, split.index).replace(/\r?\n[\t ]+/g, ' ');
  const body = source.slice(split.index + split[0].length);
  if (/^content-disposition:\s*attachment/im.test(headers)) return '';
  const contentType = /^content-type:\s*([^\r\n]+)/im.exec(headers)?.[1] ?? 'text/plain';
  if (/^multipart\//i.test(contentType)) {
    const boundary = /boundary\s*=\s*(?:"([^"\r\n]{1,200})"|([^;\s]{1,200}))/i.exec(contentType);
    const value = boundary?.[1] ?? boundary?.[2];
    if (value === undefined) return '';
    const parts = body.split(`--${value}`);
    if (parts.length > 66) throw new ConnectorError('INVALID_RESPONSE');
    return parts
      .slice(1)
      .filter((part) => !part.startsWith('--'))
      .map((part) => mimeText(part.replace(/^\r?\n/, ''), depth + 1))
      .join('\n')
      .slice(0, 131072);
  }
  if (!/^text\/(?:plain|html)(?:;|$)/i.test(contentType)) return '';
  const encoding = /^content-transfer-encoding:\s*([^\r\n]+)/im
    .exec(headers)?.[1]
    ?.trim()
    .toLowerCase();
  if (encoding === 'base64')
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8').slice(0, 131072);
  if (encoding === 'quoted-printable') {
    const binary = body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9a-f]{2})/gi, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    return Buffer.from(binary, 'latin1').toString('utf8').slice(0, 131072);
  }
  return body.slice(0, 131072);
}

function normalizedMail(message: FetchMessageObject): MailboxMessage {
  const date = message.internalDate;
  if (date === undefined) throw new ConnectorError('INVALID_RESPONSE');
  const receivedAt = date instanceof Date ? date.toISOString() : new Date(date).toISOString();
  const envelope = message.envelope;
  const text = mimeText(message.source?.toString('utf8') ?? '');
  return parseResponse(
    {
      uid: message.uid,
      ...(envelope?.messageId === undefined ? {} : { messageId: envelope.messageId }),
      subject: (envelope?.subject ?? '').slice(0, 2000),
      from: (envelope?.from ?? [])
        .map((sender) => sender.address ?? sender.name ?? '')
        .join(', ')
        .slice(0, 4000),
      text: (message.source !== undefined &&
      message.size !== undefined &&
      message.size > message.source.byteLength
        ? `${text}\n[Message preview truncated]`
        : text
      ).slice(0, 131072),
      receivedAt,
    },
    mailboxMessageSchema,
  );
}

export const officialMailTransport: MailTransport = {
  async list(input) {
    return withImap(input, async (client, signal) => {
      const lock = await client.getMailboxLock(input.mailbox, { readOnly: true });
      try {
        if (client.mailbox === false) throw new ConnectorError('INVALID_RESPONSE');
        const selected = client.mailbox;
        const uidValidity = selected.uidValidity.toString();
        const nextUid = selected.uidNext;
        const incremental = input.afterUid !== undefined;
        const after = input.uidValidity === uidValidity ? (input.afterUid ?? 0) : 0;
        const scannedThrough = incremental
          ? Math.min(nextUid - 1, after + input.limit)
          : nextUid - 1;
        if (selected.exists === 0 || (incremental && scannedThrough <= after))
          return {
            uidValidity,
            messages: [],
            hasMore: false,
            ...(incremental ? { scannedThrough: Math.max(after, scannedThrough) } : {}),
          };
        const range = incremental
          ? `${after + 1}:${scannedThrough}`
          : `${Math.max(1, selected.exists - input.limit + 1)}:${selected.exists}`;
        const messages = await boundedOperation(
          client.fetchAll(
            range,
            {
              uid: true,
              envelope: true,
              internalDate: true,
              size: true,
              source: { start: 0, maxLength: 8192 },
            },
            { uid: incremental },
          ),
          signal,
        );
        if (messages.length > input.limit) throw new ConnectorError('INVALID_RESPONSE');
        return {
          uidValidity,
          messages: messages.map(normalizedMail),
          hasMore: incremental ? scannedThrough < nextUid - 1 : selected.exists > input.limit,
          ...(incremental ? { scannedThrough } : {}),
        };
      } finally {
        lock.release();
      }
    });
  },
  async read(input) {
    return withImap(input, async (client, signal) => {
      const lock = await client.getMailboxLock(input.mailbox, { readOnly: true });
      try {
        const message = await boundedOperation(
          client.fetchOne(
            String(input.uid),
            {
              uid: true,
              envelope: true,
              internalDate: true,
              size: true,
              source: { start: 0, maxLength: 131072 },
            },
            { uid: true },
          ),
          signal,
        );
        if (!message) throw new ConnectorError('REQUEST_REJECTED');
        return normalizedMail(message);
      } finally {
        lock.release();
      }
    });
  },
  async send(input) {
    const { smtpHost, email } = input.account.options;
    if (smtpHost === undefined || email === undefined)
      throw new ConnectorError('ACCOUNT_UNAVAILABLE');
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30000)]);
    checkAbort(signal);
    const secure = input.account.options.smtpSecure ?? true;
    const transport = nodemailer.createTransport({
      host: smtpHost,
      port: input.account.options.smtpPort ?? (secure ? 465 : 587),
      secure,
      requireTLS: !secure,
      auth: { user: email, pass: input.password },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      logger: false,
      debug: false,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const onAbort = () => transport.close();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await boundedOperation(
        transport.sendMail({
          from: email,
          to: input.message.to,
          cc: input.message.cc,
          subject: input.message.subject,
          text: input.message.text,
          messageId: input.messageId,
          disableFileAccess: true,
          disableUrlAccess: true,
        }),
        signal,
      );
      return {
        messageId: result.messageId,
        accepted: parseResponse(result.accepted, z.array(z.string().max(254)).max(100)),
        rejected: parseResponse(result.rejected, z.array(z.string().max(254)).max(100)),
      };
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ConnectorError('TRANSPORT_FAILED');
    } finally {
      signal.removeEventListener('abort', onAbort);
      transport.close();
    }
  },
  async findSent(input) {
    return withImap(input, async (client, signal) => {
      const lock = await client.getMailboxLock(input.mailbox, { readOnly: true });
      try {
        const found = await boundedOperation(
          client.search({ header: { 'message-id': input.messageId } }, { uid: true }),
          signal,
        );
        if (!Array.isArray(found) || found.length !== 1) return null;
        // IMAP HEADER search matches substrings. Confirm the exact identifier before
        // treating a recovered intent as delivered.
        const message = await boundedOperation(
          client.fetchOne(String(found[0]!), { uid: true, envelope: true }, { uid: true }),
          signal,
        );
        if (!message || message.uid !== found[0] || message.envelope?.messageId !== input.messageId)
          return null;
        return { uid: message.uid };
      } finally {
        lock.release();
      }
    });
  },
};

export async function pollImapAccount(
  accountValue: ConnectorAccount,
  context: Pick<ToolContext, 'secret' | 'signal' | 'redact'>,
  optionsValue: ImapPollOptions,
  transport: MailTransport = officialMailTransport,
): Promise<MailListing> {
  const account = parseResponse(accountValue, connectorAccountSchema);
  const options = parseResponse(optionsValue, pollOptionsSchema);
  assertAccountPermission(account, 'imap-smtp', 'email:read');
  return useSecret(context, account.secretRef, async (password) => {
    assertOutbound(context, options);
    const result = parseResponse(
      await transport.list({ account, password, signal: context.signal, ...options }),
      mailListingSchema,
    );
    if (
      result.messages.length > options.limit ||
      new Set(result.messages.map((message) => message.uid)).size !== result.messages.length
    )
      throw new ConnectorError('INVALID_RESPONSE');
    return parseResponse(
      secretRedactor.redact(context.redact === undefined ? result : context.redact(result)),
      mailListingSchema,
    );
  });
}

export function createEmailTools(dependencies: ConnectorDependencies): RegisteredTool[] {
  const transport = dependencies.mail ?? officialMailTransport;
  const common = { provider: 'imap-smtp', roles: ['comms'] } as const;
  const transportSentResult = z.strictObject({
    messageId: z.string().max(200),
    accepted: z.array(z.string().max(254)).max(100),
    rejected: z.array(z.string().max(254)).max(100),
  });
  const sentResult = transportSentResult.extend({
    recipientStatus: z.enum(['confirmed', 'unknown']),
  });
  return [
    defineAccountTool(dependencies, {
      ...common,
      name: 'email.list',
      description: 'List recent IMAP message previews from a mailbox, without marking them read.',
      effect: 'read',
      permission: 'email:read',
      input: accountInput.extend({
        mailbox: mailbox.default('INBOX'),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      output: mailListingSchema,
      run: async (context, account, args) =>
        useSecret(context, account.secretRef, async (password) => {
          assertOutbound(context, args);
          return parseResponse(
            await transport.list({
              account,
              password,
              mailbox: args.mailbox,
              limit: args.limit,
              signal: context.signal,
            }),
            mailListingSchema,
          );
        }),
    }),
    defineAccountTool(dependencies, {
      ...common,
      name: 'email.read',
      description: 'Read bounded IMAP message text by UID without setting its Seen flag.',
      effect: 'read',
      permission: 'email:read',
      input: accountInput.extend({
        mailbox: mailbox.default('INBOX'),
        uid: z.number().int().positive().max(4294967295),
      }),
      output: mailboxMessageSchema,
      run: async (context, account, args) =>
        useSecret(context, account.secretRef, async (password) => {
          assertOutbound(context, args);
          return parseResponse(
            await transport.read({
              account,
              password,
              mailbox: args.mailbox,
              uid: args.uid,
              signal: context.signal,
            }),
            mailboxMessageSchema,
          );
        }),
    }),
    defineAccountTool(dependencies, {
      ...common,
      name: 'email.draft',
      description: 'Prepare a local email draft for review; the durable step stores its content.',
      effect: 'write',
      permission: 'email:draft',
      input: accountInput.extend(emailMessageSchema.shape),
      output: z.strictObject({
        draft: emailMessageSchema,
        messageId: z.string().max(200),
        stored: z.literal('run-step'),
      }),
      run: async (context, account, args) =>
        useSecret(context, account.secretRef, () => {
          assertOutbound(context, args);
          return Promise.resolve({
            draft: emailMessageSchema.parse({
              to: args.to,
              cc: args.cc,
              subject: args.subject,
              text: args.text,
            }),
            messageId: emailMessageId(context, account.id),
            stored: 'run-step' as const,
          });
        }),
      // Pure draft generation has no remote side effect and is safe to perform again after an intent-only crash.
      verify: () => Promise.resolve({ status: 'not_done' }),
    }),
    defineAccountTool(dependencies, {
      ...common,
      name: 'email.send',
      description: 'Send plain-text email through configured SMTP after policy approval.',
      effect: 'send',
      permission: 'email:send',
      input: accountInput.extend(emailMessageSchema.shape),
      output: sentResult,
      run: async (context, account, args) =>
        useSecret(context, account.secretRef, async (password) => {
          assertOutbound(context, { ...args, from: account.options.email });
          return {
            ...parseResponse(
              await transport.send({
                account,
                password,
                message: emailMessageSchema.parse({
                  to: args.to,
                  cc: args.cc,
                  subject: args.subject,
                  text: args.text,
                }),
                messageId: emailMessageId(context, account.id),
                signal: context.signal,
              }),
              transportSentResult,
            ),
            recipientStatus: 'confirmed' as const,
          };
        }),
      verify: async (context, account, args) => {
        if (account.options.sentMailbox === undefined) return { status: 'unknown' };
        try {
          assertAccountPermission(account, 'imap-smtp', 'email:read');
        } catch (error) {
          if (error instanceof ConnectorError && error.connectorCode === 'ACCOUNT_SCOPE_DENIED')
            return { status: 'unknown' };
          throw error;
        }
        return useSecret(context, account.secretRef, async (password) => {
          assertOutbound(context, args);
          const messageId = emailMessageId(context, account.id);
          const found = await transport.findSent({
            account,
            password,
            mailbox: account.options.sentMailbox!,
            messageId,
            signal: context.signal,
          });
          // SMTP does not guarantee that delivered mail appears in SENT. Never infer non-delivery from absence.
          if (found === null) return { status: 'unknown' };
          parseResponse(
            found,
            z.strictObject({ uid: z.number().int().positive().max(4294967295) }),
          );
          return {
            status: 'done',
            result: { messageId, accepted: [], rejected: [], recipientStatus: 'unknown' as const },
          };
        });
      },
    }),
  ];
}
