import { z } from 'zod';
import { workId } from './work';
import { connectorPermissionSchema } from './connectors';
export { connectorPermissionSchema } from './connectors';

export const agentRoleSchema = z.enum([
  'cos',
  'researcher',
  'comms',
  'coder',
  'analyst',
  'operator',
  'scheduler',
  'writer',
  'monitor',
  'auditor',
]);
export type AgentRole = z.infer<typeof agentRoleSchema>;
const pattern = z
  .string()
  .max(120)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*(?:\.\*)?$/);
const unique = <T>(items: T[]) => new Set(items).size === items.length;
export const agentDefinitionSchema = z
  .strictObject({
    id: agentRoleSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    instructions: z.string().trim().min(1).max(12000),
    enabled: z.boolean().default(true),
    model: z.strictObject({ role: z.enum(['planner', 'executor', 'fast']) }),
    tools: z.array(pattern).max(80).refine(unique),
    permissions: z.strictObject({
      preset: z.literal('inherit'),
      deny: z.array(pattern).max(80).refine(unique),
    }),
    memory: z.strictObject({
      read: z
        .array(z.enum(['global', 'project', 'agent']))
        .max(3)
        .refine(unique),
      write: z.enum(['proposals', 'none']),
    }),
    budget: z.strictObject({
      max_steps: z.number().int().min(1).max(1000),
      max_cost_usd: z.number().finite().min(0).max(10000),
      max_wall_time_seconds: z.number().int().min(1).max(86400),
    }),
    max_concurrent: z.number().int().min(1).max(16),
    handoff_to: z.array(agentRoleSchema).max(10).refine(unique),
    identity: z.strictObject({
      display: z.string().trim().min(1).max(120),
      connector_accounts: z
        .array(
          z.strictObject({
            accountId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
            permissions: z.array(connectorPermissionSchema).min(1).max(50).refine(unique),
          }),
        )
        .max(30)
        .refine((items) => unique(items.map((item) => item.accountId))),
      outbound_footer: z.string().max(200).default(''),
    }),
  })
  .superRefine((value, context) => {
    if (
      value.id === 'auditor' &&
      (value.identity.connector_accounts.length || value.memory.write !== 'none')
    )
      context.addIssue({
        code: 'custom',
        message: 'Auditor has no connector grants or memory writes.',
      });
  });
export const agentWriteSchema = z
  .strictObject({
    expectedVersion: z.number().int().positive(),
    definition: agentDefinitionSchema.optional(),
    yaml: z.string().max(24000).optional(),
  })
  .refine(
    (value) => (value.definition === undefined) !== (value.yaml === undefined),
    'Supply one definition format.',
  );
export const agentRevisionSchema = z.strictObject({
  id: workId,
  role: agentRoleSchema,
  version: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  definition: agentDefinitionSchema,
  yaml: z.string(),
  createdAt: z.iso.datetime(),
});
export const agentSummarySchema = z.strictObject({
  id: workId,
  role: agentRoleSchema,
  version: z.number().int().positive(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  modelRole: z.enum(['planner', 'executor', 'fast']),
  display: z.string(),
  accounts: z.number().int().nonnegative(),
});
export const agentRollbackSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  version: z.number().int().positive(),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type AgentRevision = z.infer<typeof agentRevisionSchema>;
