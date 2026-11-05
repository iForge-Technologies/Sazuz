import { z } from 'zod';
import { workId } from './work';
import { agentRoleSchema } from './agents';

export const mcpEffectSchema = z.enum(['read', 'write', 'send', 'delete', 'spend', 'publish']);
export const mcpTransportSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('http'),
    url: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        );
      }, 'Use an HTTPS endpoint without credentials, a query or a fragment.'),
    secretRef: z
      .string()
      .regex(/^secret:\/\/sec_[0-9A-HJKMNP-TV-Z]{26}$/)
      .nullable()
      .default(null),
  }),
  z.strictObject({
    kind: z.literal('stdio'),
    image: z
      .string()
      .max(300)
      .regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
    command: z
      .string()
      .max(256)
      .regex(/^\/[a-zA-Z0-9_./-]+$/)
      .refine((value) => !value.split('/').includes('..')),
    args: z
      .array(
        z
          .string()
          .max(1024)
          .refine((value) => [...value].every((char) => char.charCodeAt(0) >= 32)),
      )
      .max(32),
  }),
]);
export type McpTransport = z.infer<typeof mcpTransportSchema>;
export const mcpToolSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_.:-]+$/),
  description: z.string().max(2000).default(''),
  inputSchema: z.record(z.string(), z.json()),
  outputSchema: z.record(z.string(), z.json()).optional(),
  annotations: z
    .strictObject({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .default({}),
});
export const mcpCatalogueSchema = z.strictObject({
  serverName: z.string().min(1).max(128),
  serverVersion: z.string().min(1).max(128),
  tools: z.array(mcpToolSchema).max(64),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const mcpPermissionSchema = z.strictObject({
  tool: mcpToolSchema.shape.name,
  effect: mcpEffectSchema.nullable().default(null),
  agents: z
    .array(agentRoleSchema)
    .max(10)
    .refine((items) => new Set(items).size === items.length),
  enabled: z.boolean().default(true),
  moneyMovement: z.boolean().default(false),
});
export const mcpConfigurationSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  transport: mcpTransportSchema,
  catalogue: mcpCatalogueSchema,
  permissions: z.array(mcpPermissionSchema).max(64),
  enabled: z.boolean().default(true),
});
export const mcpInspectSchema = z.strictObject({
  projectId: workId,
  transport: mcpTransportSchema,
});
export const mcpSaveSchema = z.strictObject({
  projectId: workId,
  name: mcpConfigurationSchema.shape.name,
  transport: mcpTransportSchema,
  expectedPin: mcpCatalogueSchema.shape.sha256,
  permissions: mcpConfigurationSchema.shape.permissions,
  expectedVersion: z.number().int().nonnegative(),
});
export const integrationControlSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  enabled: z.boolean(),
});
export const mcpServerSchema = z.strictObject({
  id: workId,
  projectId: workId,
  version: z.number().int().positive(),
  configuration: mcpConfigurationSchema,
  warning: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export const mcpIncomingToolSchema = z.enum([
  'create_mission',
  'get_mission_status',
  'search_memory',
  'search_kb',
  'list_approvals',
]);
export const mcpClientInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  projectId: workId,
  secretRef: z.string().regex(/^secret:\/\/sec_[0-9A-HJKMNP-TV-Z]{26}$/),
  tools: z
    .array(mcpIncomingToolSchema)
    .min(1)
    .max(5)
    .refine((items) => new Set(items).size === items.length),
  allowPrivate: z.boolean().default(false),
});
export const mcpClientSchema = mcpClientInputSchema.extend({
  id: workId,
  enabled: z.boolean(),
  version: z.number().int().positive(),
});
export const externalExecutionSchema = z.strictObject({
  workerId: z.string().regex(/^wrk_[0-9A-HJKMNP-TV-Z]{26}$/),
  runId: workId,
  claimKey: z.uuid(),
  callKey: z.string().min(1).max(256),
  tool: z.string().min(1).max(128),
  args: z.record(z.string(), z.json()),
  verify: z.boolean(),
  nonce: z.uuid(),
  expiresAt: z.number().int().positive(),
});
export const externalResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('done'), output: z.json() }),
  z.strictObject({ status: z.literal('unknown') }),
  z.strictObject({ status: z.literal('not_done') }),
]);
export type McpConfiguration = z.infer<typeof mcpConfigurationSchema>;
export type McpCatalogue = z.infer<typeof mcpCatalogueSchema>;
export type McpTool = z.infer<typeof mcpToolSchema>;
export type ExternalExecution = z.infer<typeof externalExecutionSchema>;
export type ExternalResult = z.infer<typeof externalResultSchema>;

export class McpError extends Error {
  constructor(
    readonly code:
      | 'MCP_INVALID'
      | 'MCP_DENIED'
      | 'MCP_CONFLICT'
      | 'MCP_CHANGED'
      | 'MCP_UNAVAILABLE'
      | 'MCP_UNCERTAIN',
  ) {
    super(
      {
        MCP_INVALID: 'The MCP configuration, schema or response is invalid or exceeds its limits.',
        MCP_DENIED: 'This MCP operation is outside the current grant.',
        MCP_CONFLICT: 'The installation changed. Reload before saving.',
        MCP_CHANGED: 'The MCP server or tool catalogue changed. Inspect and review the new pin.',
        MCP_UNAVAILABLE: 'The MCP connection is unavailable. Check the endpoint or sandbox image.',
        MCP_UNCERTAIN:
          'The MCP call may have completed. Reconcile its outcome before another attempt.',
      }[code],
    );
    this.name = 'McpError';
  }
}
