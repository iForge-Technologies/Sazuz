import { z } from 'zod';
import { agentRoleSchema } from '@sazuz/core/agents';

export const integrationId = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
export const credentialRef = z.string().regex(/^secret:\/\/sec_[0-9A-HJKMNP-TV-Z]{26}$/);
const label = z.string().trim().min(1).max(120);
export const channelConnectionSchema = z.strictObject({
  id: integrationId,
  name: label,
  kind: z.enum(['discord', 'slack', 'whatsapp-cloud', 'whatsapp-qr']),
  enabled: z.boolean().default(false),
  secretRef: credentialRef.nullable().default(null),
  signingSecretRef: credentialRef.nullable().default(null),
  verifyTokenRef: credentialRef.nullable().default(null),
  applicationId: z.string().max(100).default(''),
  publicKey: z
    .string()
    .regex(/^(?:[a-fA-F0-9]{64})?$/)
    .default(''),
  phoneNumberId: z
    .string()
    .regex(/^\d{0,30}$/)
    .default(''),
  apiVersion: z
    .string()
    .regex(/^v\d{1,3}\.0$/)
    .default('v23.0'),
  projectId: z.string().regex(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/),
  allowedSenders: z.array(z.string().trim().min(1).max(160)).max(100).default([]),
  allowedConversations: z.array(z.string().trim().min(1).max(160)).max(100).default([]),
});
export type ChannelConnection = z.infer<typeof channelConnectionSchema>;

export function validateMcpInputSchema(schema: Record<string, unknown>): z.ZodType {
  if (schema.type !== 'object' || JSON.stringify(schema).length > 32_768)
    throw new Error('Unsupported MCP schema.');
  function visit(value: unknown, depth: number) {
    if (depth > 12) throw new Error('MCP schema is too deeply nested.');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (
        [
          '$ref',
          '$dynamicRef',
          'pattern',
          'patternProperties',
          'unevaluatedProperties',
          'unevaluatedItems',
        ].includes(key)
      )
        throw new Error('Unsupported MCP schema feature.');
      visit(child, depth + 1);
    }
  }
  visit(schema, 0);
  return z.fromJSONSchema(schema);
}
export const mcpToolSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  description: z.string().max(2000),
  inputSchema: z.record(z.string(), z.json()).superRefine((schema, ctx) => {
    try {
      validateMcpInputSchema(schema);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Unsupported MCP input schema.' });
    }
  }),
  effect: z
    .enum(['read', 'write', 'send', 'delete', 'spend', 'publish', 'unknown'])
    .default('unknown'),
  enabled: z.boolean().default(false),
});
export const mcpConnectionSchema = z.strictObject({
  id: integrationId,
  name: label,
  url: z
    .url()
    .max(2048)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      );
    }),
  enabled: z.boolean().default(false),
  secretRef: credentialRef.nullable().default(null),
  agents: z
    .array(agentRoleSchema)
    .max(10)
    .refine((items) => new Set(items).size === items.length)
    .default([]),
  tools: z
    .array(mcpToolSchema)
    .max(100)
    .refine((items) => new Set(items.map((item) => item.name)).size === items.length)
    .default([]),
});
export type McpConnection = z.infer<typeof mcpConnectionSchema>;
export function uniqueConnections(items: { id: string }[]): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}
