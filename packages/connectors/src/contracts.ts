import { z } from 'zod';
import type { ToolContext } from '@sazuz/tools';
import type { MailTransport } from './mail.js';
import {
  connectorProviderSchema,
  connectorResourceFields,
  type ConnectorPermissionId,
} from '@sazuz/core/connectors';

const handle = z.string().regex(/^secret:\/\/[A-Za-z0-9_-]{1,128}$/);
const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.-]+$/);
export const connectorAccountSchema = z.strictObject({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  kind: z.enum(['email', 'calendar', 'github', 'chat', 'productivity']),
  secretRef: handle.nullable(),
  scopes: z.array(z.string().trim().min(1).max(120)).max(30),
  mode: z.enum(['read', 'read-write']),
  provider: connectorProviderSchema.nullable(),
  options: z.strictObject({
    ...connectorResourceFields,
    email: z.email().max(254).optional(),
    imapHost: host.optional(),
    imapPort: z.number().int().min(1).max(65535).optional(),
    imapSecure: z.boolean().optional(),
    smtpHost: host.optional(),
    smtpPort: z.number().int().min(1).max(65535).optional(),
    smtpSecure: z.boolean().optional(),
    sentMailbox: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\r\n\0]+$/)
      .optional(),
    calendarId: z.string().min(1).max(254).optional(),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .max(200)
      .optional(),
    oauthClientId: z.string().min(1).max(300).optional(),
    oauthClientSecretRef: handle.optional(),
    oauthRedirectUri: z.url().max(2048).optional(),
  }),
});

export type ConnectorAccount = z.infer<typeof connectorAccountSchema>;
export type ConnectorProvider = NonNullable<ConnectorAccount['provider']>;
export type ConnectorAgentRole = 'chief-of-staff' | 'researcher' | 'comms' | 'coder';
export type ConnectorPermission = ConnectorPermissionId;

export interface ConnectorDependencies {
  getAccounts: () => readonly ConnectorAccount[] | Promise<readonly ConnectorAccount[]>;
  getAgentRole?: (agentId: string) => ConnectorAgentRole | null;
  authorizeAccount?: (
    context: ToolContext,
    account: ConnectorAccount,
    permission: ConnectorPermission,
    action: { name: string; effect: string },
  ) => Promise<boolean>;
  fetch?: typeof globalThis.fetch;
  mail?: MailTransport;
}

export type ConnectorSecretContext = Pick<ToolContext, 'secret' | 'signal' | 'redact'>;

export const emailMessageSchema = z.strictObject({
  to: z.array(z.email().max(254)).min(1).max(50),
  cc: z.array(z.email().max(254)).max(50).default([]),
  subject: z
    .string()
    .min(1)
    .max(998)
    .regex(/^[^\r\n\0]+$/),
  text: z.string().min(1).max(100_000),
});
export type EmailMessage = z.infer<typeof emailMessageSchema>;

const maxUid = 4_294_967_295;
export const mailboxMessageSchema = z.strictObject({
  uid: z.number().int().positive().max(maxUid),
  messageId: z.string().max(1000).optional(),
  subject: z.string().max(2000),
  from: z.string().max(4000),
  text: z.string().max(131_072),
  receivedAt: z.iso.datetime(),
});
export const mailListingSchema = z.strictObject({
  uidValidity: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .refine((value) => Number(value) <= maxUid),
  messages: z.array(mailboxMessageSchema).max(100),
  hasMore: z.boolean(),
  scannedThrough: z.number().int().nonnegative().max(maxUid).optional(),
});
export type MailListing = z.infer<typeof mailListingSchema>;
export type MailboxMessage = z.infer<typeof mailboxMessageSchema>;
