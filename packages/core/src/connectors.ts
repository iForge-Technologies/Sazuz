import { z } from 'zod';

export const connectorProviderSchema = z.enum([
  'gmail',
  'imap-smtp',
  'google-calendar',
  'github',
  'google-drive',
  'google-sheets',
  'google-docs',
  'microsoft-graph',
  'slack',
  'discord',
  'notion',
  'todoist',
  'caldav',
  'carddav',
  'linear',
  'jira',
  'stripe',
  'webhook',
]);
export const connectorPermissionSchema = z.enum([
  'email:read',
  'email:draft',
  'email:send',
  'calendar:read',
  'calendar:write',
  'calendar:delete',
  'github:read',
  'github:write',
  'drive:read',
  'drive:write',
  'sheets:read',
  'sheets:write',
  'docs:read',
  'docs:write',
  'outlook:read',
  'outlook:send',
  'graph-calendar:read',
  'graph-calendar:write',
  'graph-calendar:delete',
  'onedrive:read',
  'onedrive:write',
  'slack:read',
  'slack:send',
  'discord:read',
  'discord:send',
  'notion:read',
  'notion:write',
  'todoist:read',
  'todoist:write',
  'caldav:read',
  'caldav:write',
  'caldav:delete',
  'carddav:read',
  'carddav:write',
  'carddav:delete',
  'linear:read',
  'linear:write',
  'jira:read',
  'jira:write',
  'stripe:read',
  'webhook:send',
]);
export type ConnectorProviderId = z.infer<typeof connectorProviderSchema>;
export type ConnectorPermissionId = z.infer<typeof connectorPermissionSchema>;

const resource = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_!.-]+$/)
  .refine((value) => value !== '.' && value !== '..');
export const connectorEndpointSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!url.port || url.port === '443')
    );
  });
/** Shared resource fields; authentication fields remain vault references in both consumers. */
export const connectorResourceFields = {
  folderId: resource.optional(),
  spreadsheetId: resource.optional(),
  documentId: resource.optional(),
  driveId: resource.optional(),
  mailFolderId: resource.optional(),
  channelId: resource.optional(),
  pageId: resource.optional(),
  dataSourceId: resource.optional(),
  projectId: resource.optional(),
  teamId: resource.optional(),
  projectKey: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .optional(),
  issueType: z.string().min(1).max(100).optional(),
  baseUrl: connectorEndpointSchema.optional(),
  username: z
    .string()
    .min(1)
    .max(254)
    .regex(/^[^\r\n\0:]+$/)
    .optional(),
  tenantId: z
    .string()
    .regex(/^(?:common|organizations|consumers|[0-9a-fA-F-]{36})$/)
    .optional(),
  tokenKind: z.enum(['api-key', 'oauth']).optional(),
} as const;

export const connectorCatalogueSchema = z.array(
  z.strictObject({
    id: z.string(),
    name: z.string(),
    auth: z.enum(['oauth2', 'apiKey', 'basic', 'none']),
    tools: z.array(
      z.strictObject({
        name: z.string(),
        description: z.string(),
        effect: z.string(),
        permission: connectorPermissionSchema,
      }),
    ),
  }),
);
