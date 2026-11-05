import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpError, mcpTransportSchema, type McpTransport } from '@sazuz/core/mcp';
import { type InfraConfig } from '@sazuz/config';
import { type SecretReference } from '@sazuz/vault';
import { catalogue } from './catalogue.js';
import { mcpHttpFetch } from './network.js';
import { containerTransport } from './stdio.js';

export interface McpConnectionOptions {
  config: InfraConfig;
  key: () => Promise<string>;
  secret<T>(reference: SecretReference, consume: (value: string) => Promise<T>): Promise<T>;
  onError(code: string): void;
  transport?: (
    value: McpTransport,
    scope: { projectId: string; agentId: string; signal: AbortSignal },
  ) => Promise<Transport>;
}

export function mcpConnection(options: McpConnectionOptions) {
  return async <T>(
    transportInput: McpTransport,
    scope: { projectId: string; agentId: string; signal: AbortSignal },
    consume: (client: Client, discovered: Awaited<ReturnType<typeof discover>>) => Promise<T>,
  ): Promise<T> => {
    const config = mcpTransportSchema.parse(transportInput);
    const controller = new AbortController();
    const signal = AbortSignal.any([scope.signal, controller.signal, AbortSignal.timeout(45_000)]);
    async function use(token?: string) {
      const http =
        config.kind === 'http' && !options.transport
          ? mcpHttpFetch({
              endpoint: config.url,
              ...scope,
              signal,
              key: await options.key(),
              config: options.config,
              ...(token ? { token } : {}),
            })
          : null;
      const transport = options.transport
        ? await options.transport(config, { ...scope, signal })
        : config.kind === 'http'
          ? new StreamableHTTPClientTransport(new URL(config.url), {
              fetch: http!.fetch,
              reconnectionOptions: {
                maxRetries: 0,
                initialReconnectionDelay: 1000,
                maxReconnectionDelay: 1000,
                reconnectionDelayGrowFactor: 1,
              },
            })
          : containerTransport({
              config: options.config,
              key: await options.key(),
              transport: config,
              ...scope,
              signal,
            });
      const client = new Client(
        { name: 'sazuz', version: 'phase7' },
        { capabilities: {}, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
      );
      client.onerror = () => options.onError('MCP_TRANSPORT_FAILED');
      const abort = () => {
        void client.close().catch(() => options.onError('MCP_CLOSE_FAILED'));
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        await client.connect(transport, { timeout: 15_000, signal });
        return await consume(client, await discover(client, signal));
      } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError('MCP_UNAVAILABLE');
      } finally {
        signal.removeEventListener('abort', abort);
        controller.abort();
        try {
          await client.close();
        } catch {
          options.onError('MCP_CLOSE_FAILED');
        }
        try {
          await http?.close();
        } catch {
          options.onError('MCP_PROXY_CLOSE_FAILED');
        }
      }
    }
    return config.kind === 'http' && config.secretRef
      ? options.secret(config.secretRef as SecretReference, use)
      : use();
  };
}
export async function discover(client: Client, signal: AbortSignal) {
  const server = client.getServerVersion();
  if (!server) throw new McpError('MCP_INVALID');
  const tools: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    // Validate bounded schemas ourselves before any SDK metadata cache can inspect them.
    const response = await client.request(
      { method: 'tools/list', params: cursor ? { cursor } : {} },
      ListToolsResultSchema,
      { timeout: 10_000, signal },
    );
    tools.push(...response.tools);
    if (tools.length > 64) throw new McpError('MCP_INVALID');
    if (!response.nextCursor) return catalogue(server, tools);
    if (seen.has(response.nextCursor) || response.nextCursor.length > 1024)
      throw new McpError('MCP_INVALID');
    cursor = response.nextCursor;
    seen.add(cursor);
  }
  throw new McpError('MCP_INVALID');
}
export type McpConnection = ReturnType<typeof mcpConnection>;
