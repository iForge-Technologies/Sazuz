import { z } from 'zod';
import { workId } from './work';
import { agentRoleSchema } from './agents';

const nodeId = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
const toolName = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/);
const common = {
  id: nodeId,
  name: z.string().trim().min(1).max(100),
  x: z.number().finite().min(-10000).max(10000).default(0),
  y: z.number().finite().min(-10000).max(10000).default(0),
};
const next = nodeId.nullable();
export const s2aNodeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('value'), value: z.json(), next }),
  z.strictObject({
    ...common,
    kind: z.literal('tool'),
    agent: agentRoleSchema.default('cos'),
    tool: toolName,
    args: z.record(z.string(), z.json()),
    next,
  }),
  z.strictObject({
    ...common,
    kind: z.literal('agent'),
    prompt: z.string().trim().min(1).max(8000),
    agent: agentRoleSchema,
    allowedTools: z.array(toolName).max(30).default([]),
    next,
  }),
  z.strictObject({
    ...common,
    kind: z.literal('condition'),
    left: z.json(),
    operator: z.enum(['equals', 'not-equals', 'contains', 'exists']),
    right: z.json(),
    yes: next,
    no: next,
  }),
  z.strictObject({
    ...common,
    kind: z.literal('approval'),
    message: z.string().min(1).max(2000),
    next,
  }),
]);
export const s2aGraphSchema = z
  .strictObject({
    entry: nodeId,
    nodes: z.array(s2aNodeSchema).min(1).max(50),
  })
  .superRefine((graph, ctx) => {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (nodes.size !== graph.nodes.length) fail('Node IDs must be unique.');
    if (!nodes.has(graph.entry)) fail('Choose an existing entry node.');
    const visited = new Set<string>();
    const active = new Set<string>();
    function visit(id: string) {
      if (active.has(id)) {
        fail('Cycles are not supported; use an acyclic workflow.');
        return;
      }
      if (visited.has(id)) return;
      const node = nodes.get(id);
      if (!node) {
        fail(`Node ${id} does not exist.`);
        return;
      }
      active.add(id);
      visited.add(id);
      for (const target of node.kind === 'condition' ? [node.yes, node.no] : [node.next])
        if (target) visit(target);
      active.delete(id);
    }
    visit(graph.entry);
    if (visited.size !== nodes.size) fail('Every node must be reachable from the entry.');
    if (JSON.stringify(graph).length > 80_000) fail('Workflow exceeds the size limit.');
  });
export type S2aGraph = z.infer<typeof s2aGraphSchema>;
export type S2aNode = z.infer<typeof s2aNodeSchema>;
export const s2aInputSchema = z.strictObject({
  projectId: workId,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(''),
  graph: s2aGraphSchema,
});
export const s2aRecordSchema = s2aInputSchema.extend({
  id: workId,
  revision: z.number().int().positive(),
  publishedRevision: z.number().int().positive().nullable(),
  updatedAt: z.iso.datetime(),
});
export const s2aUpdateSchema = s2aInputSchema
  .omit({ projectId: true })
  .extend({ expectedRevision: z.number().int().positive() });
export const s2aRunInputSchema = z.strictObject({
  requestId: z.uuid(),
  input: z.record(z.string(), z.json()).default({}),
  revision: z.number().int().positive(),
});
export const s2aStateSchema = z.strictObject({
  workflowId: workId,
  revision: z.number().int().positive(),
  graph: s2aGraphSchema,
  input: z.record(z.string(), z.json()),
  next: nodeId.nullable(),
  outputs: z.record(z.string(), z.json()),
  failure: z.string().nullable(),
});
export type S2aState = z.infer<typeof s2aStateSchema>;
export const s2aScheduleInputSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  expression: z.string().trim().min(1).max(100),
  timezone: z.string().min(1).max(100),
  enabled: z.boolean(),
  input: z.record(z.string(), z.json()).default({}),
});
export const s2aScheduleSchema = s2aScheduleInputSchema.extend({
  workflowId: workId,
  nextRunAt: z.iso.datetime(),
});
