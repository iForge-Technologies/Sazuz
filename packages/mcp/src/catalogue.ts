import { z } from 'zod';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import {
  McpError,
  mcpCatalogueSchema,
  mcpToolSchema,
  type McpCatalogue,
  type McpTool,
} from '@sazuz/core/mcp';
import { valueHash } from '@sazuz/db';
import { secretRedactor } from '@sazuz/vault';

export function boundedJson(value: unknown, bytes = 65_536, maxDepth = 16): void {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > bytes) throw new McpError('MCP_INVALID');
    const stack = [{ value, depth: 0 }];
    let count = 0;
    while (stack.length) {
      const item = stack.pop()!;
      if (++count > 4096 || item.depth > maxDepth) throw new McpError('MCP_INVALID');
      if (item.value && typeof item.value === 'object')
        for (const child of Object.values(item.value))
          stack.push({ value: child, depth: item.depth + 1 });
    }
  } catch {
    throw new McpError('MCP_INVALID');
  }
}

/** Interpret reviewed inline schemas; never compile source code or resolve schema URLs. */
export function inputValidator(input: McpTool['inputSchema']) {
  boundedJson(input, 16_384, 12);
  if (input.type !== 'object') throw new McpError('MCP_INVALID');
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['$ref', '$dynamicRef', '$recursiveRef', '$id', 'patternProperties'].includes(key))
        throw new McpError('MCP_INVALID');
      if (key === 'pattern') {
        if (
          typeof child !== 'string' ||
          child.length > 128 ||
          !child.startsWith('^') ||
          !child.endsWith('$')
        )
          throw new McpError('MCP_INVALID');
        const plain = child.replace(/\[[^\]]*\]/g, 'x').replace(/\\[a-zA-Z\W]/g, 'x');
        if (/[()|]/.test(plain) || /\\\d/.test(plain) || (plain.match(/[+*?{]/g)?.length ?? 0) > 1)
          throw new McpError('MCP_INVALID');
      }
      visit(child);
    }
  };
  visit(input);
  try {
    const validate = new CfWorkerJsonSchemaValidator().getValidator(input);
    return (value: unknown) => {
      boundedJson(value);
      const parsed = z.record(z.string().max(128), z.json()).safeParse(value);
      if (!parsed.success || !validate(parsed.data).valid) throw new McpError('MCP_INVALID');
      if (valueHash(secretRedactor.redact(parsed.data)) !== valueHash(parsed.data))
        throw new McpError('MCP_DENIED');
      return parsed.data;
    };
  } catch {
    throw new McpError('MCP_INVALID');
  }
}

export function catalogue(
  server: { name: string; version: string },
  tools: unknown[],
): McpCatalogue {
  boundedJson(tools, 262_144, 18);
  const parsed = tools
    .map((raw) => {
      const remote = z
        .object({
          name: z.string(),
          description: z.string().optional(),
          inputSchema: z.record(z.string(), z.json()),
          outputSchema: z.record(z.string(), z.json()).optional(),
          annotations: z
            .object({
              readOnlyHint: z.boolean().optional(),
              destructiveHint: z.boolean().optional(),
              idempotentHint: z.boolean().optional(),
              openWorldHint: z.boolean().optional(),
            })
            .optional(),
        })
        .parse(raw);
      const tool = mcpToolSchema.parse({
        ...remote,
        description: remote.description ?? '',
        annotations: remote.annotations ?? {},
      });
      inputValidator(tool.inputSchema);
      if (tool.outputSchema) inputValidator(tool.outputSchema);
      return tool;
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  if (new Set(parsed.map((tool) => tool.name)).size !== parsed.length)
    throw new McpError('MCP_INVALID');
  const value = { serverName: server.name, serverVersion: server.version, tools: parsed };
  if (valueHash(secretRedactor.redact(value)) !== valueHash(value))
    throw new McpError('MCP_DENIED');
  return mcpCatalogueSchema.parse({ ...value, sha256: valueHash(value) });
}

export const mcpToolName = (serverId: string, name: string) =>
  `mcp.${serverId.toLowerCase()}.t_${valueHash(name).slice(0, 16)}`;
export const untrustedText = (value: string) =>
  `<untrusted>${value.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}</untrusted>`;

/** Remote prose in schemas is neither instructions nor a default argument. */
export function promptSchema(value: Record<string, unknown>): Record<string, unknown> {
  const visit = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(visit)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .filter(
                ([key]) =>
                  !['description', 'title', '$comment', 'examples', 'default'].includes(key),
              )
              .map(([key, child]) => [key, visit(child)]),
          )
        : item;
  return visit(value) as Record<string, unknown>;
}
