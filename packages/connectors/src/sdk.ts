import { createHash } from 'node:crypto';
import {
  checkAbort,
  defineTool,
  ToolError,
  type RegisteredTool,
  type ToolContext,
  type Verification,
} from '@sazuz/tools';
import { secretRedactor } from '@sazuz/vault';
import { z } from 'zod';
import {
  connectorAccountSchema,
  type ConnectorAccount,
  type ConnectorAgentRole,
  type ConnectorDependencies,
  type ConnectorPermission,
  type ConnectorProvider,
  type ConnectorSecretContext,
} from './contracts.js';
import { ConnectorError } from './errors.js';

export const accountInput = z.strictObject({ accountId: z.string().min(1).max(128) });

const scopes: Readonly<Partial<Record<ConnectorPermission, readonly string[]>>> = {
  'email:read': [
    'email:read',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://mail.google.com/',
  ],
  'email:draft': [
    'email:draft',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://mail.google.com/',
  ],
  'email:send': [
    'email:send',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://mail.google.com/',
  ],
  'calendar:read': [
    'calendar:read',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar',
  ],
  'calendar:write': [
    'calendar:write',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar',
  ],
  'calendar:delete': [
    'calendar:delete',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar',
  ],
  'github:read': ['github:read', 'repo:read', 'repo', 'public_repo'],
  'github:write': ['github:write', 'repo', 'public_repo'],
  'drive:read': [
    'drive:read',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
  ],
  'drive:write': ['drive:write', 'https://www.googleapis.com/auth/drive.file'],
  'sheets:read': [
    'sheets:read',
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/spreadsheets',
  ],
  'sheets:write': ['sheets:write', 'https://www.googleapis.com/auth/spreadsheets'],
  'docs:read': [
    'docs:read',
    'https://www.googleapis.com/auth/documents.readonly',
    'https://www.googleapis.com/auth/documents',
  ],
  'docs:write': ['docs:write', 'https://www.googleapis.com/auth/documents'],
  'outlook:read': ['outlook:read', 'Mail.Read'],
  'outlook:send': ['outlook:send', 'Mail.Send'],
  'graph-calendar:read': ['graph-calendar:read', 'Calendars.Read', 'Calendars.ReadWrite'],
  'graph-calendar:write': ['graph-calendar:write', 'Calendars.ReadWrite'],
  'graph-calendar:delete': ['graph-calendar:delete', 'Calendars.ReadWrite'],
  'onedrive:read': ['onedrive:read', 'Files.Read', 'Files.ReadWrite'],
  'onedrive:write': ['onedrive:write', 'Files.ReadWrite'],
};

export function assertAccountPermission(
  account: ConnectorAccount,
  provider: ConnectorProvider,
  permission: ConnectorPermission,
): void {
  const kind =
    provider === 'google-calendar' || provider === 'caldav'
      ? 'calendar'
      : provider === 'github'
        ? 'github'
        : provider === 'gmail' || provider === 'imap-smtp'
          ? 'email'
          : provider === 'slack' || provider === 'discord'
            ? 'chat'
            : 'productivity';
  if (account.provider !== provider || account.kind !== kind || account.secretRef === null)
    throw new ConnectorError('ACCOUNT_UNAVAILABLE');
  if (
    (permission.endsWith(':read') ? false : account.mode !== 'read-write') ||
    !(scopes[permission] ?? [permission]).some((scope) => account.scopes.includes(scope))
  )
    throw new ConnectorError('ACCOUNT_SCOPE_DENIED');
}

function defaultRole(agentId: string): ConnectorAgentRole | null {
  if (['cos', 'chief-of-staff', 'chief_of_staff'].includes(agentId)) return 'chief-of-staff';
  return ['researcher', 'comms', 'coder'].includes(agentId)
    ? (agentId as ConnectorAgentRole)
    : null;
}

export async function resolveAccount(
  dependencies: ConnectorDependencies,
  context: ToolContext,
  id: string,
  provider: ConnectorProvider,
  permission: ConnectorPermission,
  roles: readonly ConnectorAgentRole[],
  action: { name: string; effect: string },
): Promise<ConnectorAccount> {
  checkAbort(context.signal);
  const role = (dependencies.getAgentRole ?? defaultRole)(context.agentId);
  if (!dependencies.authorizeAccount && (role === null || !roles.includes(role)))
    throw new ConnectorError('AGENT_SCOPE_DENIED');
  const parsed = z
    .array(connectorAccountSchema)
    .max(100)
    .safeParse(await dependencies.getAccounts());
  if (!parsed.success) throw new ConnectorError('ACCOUNT_UNAVAILABLE');
  const matches = parsed.data.filter((account) => account.id === id);
  if (matches.length !== 1) throw new ConnectorError('ACCOUNT_UNAVAILABLE');
  const account = matches[0]!;
  assertAccountPermission(account, provider, permission);
  if (
    dependencies.authorizeAccount &&
    !(await dependencies.authorizeAccount(context, account, permission, action))
  )
    throw new ConnectorError('AGENT_SCOPE_DENIED');
  return account;
}

/** Check after credential resolution as well as the registry's preflight check. */
export function assertOutbound(context: ConnectorSecretContext, value: unknown): void {
  const scrubbed = secretRedactor.redact(value);
  const safe =
    context.redact === undefined ? scrubbed : secretRedactor.redact(context.redact(scrubbed));
  if (JSON.stringify(value) !== JSON.stringify(safe)) throw new ToolError('SECRET_INPUT');
}

export async function useSecret<T>(
  context: ConnectorSecretContext,
  reference: string | null,
  consume: (secret: string) => Promise<T>,
): Promise<T> {
  checkAbort(context.signal);
  if (context.secret === undefined || reference === null)
    throw new ConnectorError('INVALID_CREDENTIAL');
  try {
    return await context.secret(reference, async (value) => {
      if (!z.string().min(1).max(65536).safeParse(value).success)
        throw new ConnectorError('INVALID_CREDENTIAL');
      secretRedactor.register(value);
      checkAbort(context.signal);
      return consume(value);
    });
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ConnectorError('INVALID_CREDENTIAL');
  }
}

export function operationMarker(
  context: Pick<ToolContext, 'idempotencyKey'>,
  accountId: string,
): string {
  if (!context.idempotencyKey || context.idempotencyKey.length > 512)
    throw new ToolError('INVALID_TOOL_ARGS');
  return createHash('sha256')
    .update(`sazuz\0${accountId}\0${context.idempotencyKey}`)
    .digest('hex');
}

export function emailMessageId(
  context: Pick<ToolContext, 'idempotencyKey'>,
  accountId: string,
): string {
  return `<sazuz-${operationMarker(context, accountId)}@id.sazuz.local>`;
}

interface AccountToolDefinition<Input extends z.ZodType, Output extends z.ZodType> {
  name: string;
  description: string;
  input: Input;
  output: Output;
  effect: 'read' | 'write' | 'send' | 'delete';
  provider: ConnectorProvider;
  permission: ConnectorPermission;
  roles: readonly ConnectorAgentRole[];
  run(
    context: ToolContext,
    account: ConnectorAccount,
    args: z.output<Input>,
  ): Promise<z.input<Output>>;
  verify?(
    context: ToolContext,
    account: ConnectorAccount,
    args: z.output<Input>,
  ): Promise<Verification<z.input<Output>>>;
}

export function defineAccountTool<Input extends z.ZodType, Output extends z.ZodType>(
  dependencies: ConnectorDependencies,
  definition: AccountToolDefinition<Input, Output>,
): RegisteredTool {
  const accountFor = async (context: ToolContext, args: z.output<Input>) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(args);
    return resolveAccount(
      dependencies,
      context,
      accountId,
      definition.provider,
      definition.permission,
      definition.roles,
      { name: definition.name, effect: definition.effect },
    );
  };
  return defineTool({
    name: definition.name,
    description: definition.description,
    input: definition.input,
    output: definition.output,
    effect: definition.effect,
    connector:
      definition.provider === 'google-calendar'
        ? 'calendar'
        : definition.provider === 'imap-smtp'
          ? 'email'
          : definition.provider,
    scope: 'external',
    untrusted: true,
    run: async (context, args) => definition.run(context, await accountFor(context, args), args),
    ...(definition.verify === undefined
      ? {}
      : {
          verify: async (context: ToolContext, args: z.output<Input>) =>
            definition.verify!(context, await accountFor(context, args), args),
        }),
  });
}

export interface ConnectorDefinition {
  id: string;
  name: string;
  auth: {
    type: 'oauth2' | 'apiKey' | 'basic' | 'none';
    scopes: { read: readonly string[]; write: readonly string[] };
  };
  tools: readonly RegisteredTool[];
}

/** Connector SDK aggregates standard policy-aware tools; execution still belongs to the runtime. */
export function defineConnector(definition: ConnectorDefinition): Readonly<ConnectorDefinition> {
  const metadata = z
    .strictObject({
      id: z
        .string()
        .regex(/^[a-z][a-z0-9-]*$/)
        .max(100),
      name: z.string().trim().min(1).max(200),
      auth: z.strictObject({
        type: z.enum(['oauth2', 'apiKey', 'basic', 'none']),
        scopes: z.strictObject({
          read: z.array(z.string().min(1).max(120)).max(30),
          write: z.array(z.string().min(1).max(120)).max(30),
        }),
      }),
    })
    .safeParse({ id: definition.id, name: definition.name, auth: definition.auth });
  if (
    !metadata.success ||
    definition.tools.some(
      (tool) => tool.scope !== 'external' || tool.connector !== definition.id,
    ) ||
    new Set(definition.tools.map((tool) => tool.name)).size !== definition.tools.length
  )
    throw new ToolError('INVALID_TOOL');
  return Object.freeze({ ...metadata.data, tools: Object.freeze([...definition.tools]) });
}
