import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { mcpConnectionSchema } from '@sazuz/config/integrations';
import type { SafeNetworkRequest, SafeNetworkResponse } from '@sazuz/tools';
import { createMcpClient, createMcpTools, inputValidator, mcpToolName } from './connections.js';

const connection = mcpConnectionSchema.parse({
  id: 'fixture',
  name: 'Fixture',
  url: 'https://example.com/mcp',
  enabled: true,
  agents: ['cos'],
});
const schema = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
  additionalProperties: false,
};
const tool = {
  name: 'query.records',
  description: 'Query records',
  inputSchema: schema,
  effect: 'read' as const,
  enabled: true,
};
function fixture(sse = false) {
  const methods: string[] = [];
  const respond = (input: SafeNetworkRequest): SafeNetworkResponse => {
    if (input.method === 'DELETE') return { status: 204, headers: {}, body: '' };
    const body = z
      .object({ method: z.string(), id: z.string().optional(), params: z.unknown() })
      .parse(JSON.parse(input.body!));
    methods.push(body.method);
    if (body.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' };
    const result =
      body.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
        : body.method === 'tools/list'
          ? { tools: [{ name: tool.name, description: tool.description, inputSchema: schema }] }
          : { content: [{ type: 'text', text: 'Result' }] };
    const response = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    return {
      status: 200,
      headers: {
        'content-type': sse ? 'text/event-stream' : 'application/json',
        'mcp-session-id': 'fixture-session',
      },
      body: sse ? `: keepalive\n\ndata: ${response}\n\ndata: {"unfinished":` : response,
    };
  };
  const request = vi.fn((input: SafeNetworkRequest) => Promise.resolve(respond(input)));
  return {
    methods,
    request,
    network: {
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 as const }]),
      request,
    },
  };
}
describe('MCP Streamable HTTP', () => {
  it('records failed session cleanup without failing a completed tool call', async () => {
    const mock = fixture();
    const original = mock.request.getMockImplementation()!;
    mock.request.mockImplementation((input) =>
      input.method === 'DELETE'
        ? Promise.reject(new Error('Cleanup disconnected'))
        : original(input),
    );
    const registered = createMcpTools(() => [{ ...connection, tools: [tool] }], mock.network)[0]!;
    await expect(
      registered.execute(
        {
          projectId: 'p',
          runId: 'r',
          workspaceDir: '.',
          agentId: 'cos',
          idempotencyKey: 'r:1:0',
          signal: AbortSignal.timeout(1000),
        },
        { query: 'sample' },
      ),
    ).resolves.toMatchObject({
      output: { content: [{ text: 'Result' }], sessionCleanup: 'failed' },
    });
  });
  it.each([false, true])(
    'negotiates the protocol and discovers tools with unknown permissions (SSE=%s)',
    async (sse) => {
      const mock = fixture(sse);
      const client = createMcpClient(connection, {
        signal: AbortSignal.timeout(1000),
        network: mock.network,
      });
      expect(await client.discover()).toEqual([{ ...tool, effect: 'unknown', enabled: false }]);
      expect(await client.call(tool.name, { query: 'sample' })).toMatchObject({
        content: [{ text: 'Result' }],
      });
      expect(mock.methods).toEqual([
        'initialize',
        'notifications/initialized',
        'tools/list',
        'tools/call',
      ]);
      await client.close();
    },
  );
  it('rejects private DNS targets before any authenticated request', async () => {
    const mock = fixture();
    const client = createMcpClient(connection, {
      signal: AbortSignal.timeout(1000),
      network: {
        ...mock.network,
        lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      },
    });
    await expect(client.discover()).rejects.toThrow();
    expect(mock.request).not.toHaveBeenCalled();
  });
  it('validates remote arguments, scopes tools to agents and preserves external trust', async () => {
    const mock = fixture();
    const connections = [{ ...connection, tools: [tool] }];
    const registered = createMcpTools(() => connections, mock.network)[0]!;
    expect(registered.name).toBe(mcpToolName(connection.id, tool.name));
    expect(() => registered.parseArgs({ query: 123 })).toThrow();
    const ctx = {
      projectId: 'p',
      runId: 'r',
      workspaceDir: '.',
      agentId: 'cos',
      idempotencyKey: 'r:1:0',
      signal: AbortSignal.timeout(1000),
    };
    expect(await registered.execute(ctx, { query: 'sample' })).toMatchObject({ untrusted: true });
    connections[0]!.agents = [];
    await expect(registered.execute(ctx, { query: 'sample' })).rejects.toThrow();
  });
  it('rejects unsupported or recursive schemas without evaluating code', () => {
    for (const invalid of [
      { type: 'array' },
      { type: 'object', $ref: 'https://example.com/schema' },
      { type: 'object', properties: { value: { type: 'string', pattern: '(a+)+$' } } },
    ])
      expect(() => inputValidator(invalid)).toThrow();
  });
  it('does not call tools when their reviewed schema changes', async () => {
    const mock = fixture();
    const changed = { ...tool, inputSchema: { type: 'object', properties: {} } };
    const registered = createMcpTools(
      () => [{ ...connection, tools: [changed] }],
      mock.network,
    )[0]!;
    await expect(
      registered.execute(
        {
          projectId: 'p',
          runId: 'r',
          workspaceDir: '.',
          agentId: 'cos',
          idempotencyKey: 'r:1:0',
          signal: AbortSignal.timeout(1000),
        },
        {},
      ),
    ).rejects.toThrow();
    expect(mock.methods).not.toContain('tools/call');
  });
});
