import { fetch as proxyFetch, ProxyAgent } from 'undici';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { InfraConfig } from '@sazuz/config';
import { McpError } from '@sazuz/core/mcp';
import { issueGrant } from '@sazuz/sandbox';
import { secretRedactor } from '@sazuz/vault';

export function mcpHttpFetch(options: {
  endpoint: string;
  projectId: string;
  agentId: string;
  key: string;
  config: Pick<InfraConfig, 'egressProxyUrl'>;
  signal: AbortSignal;
  token?: string;
}) {
  const url = new URL(options.endpoint);
  const capability = issueGrant(options.key, {
    service: 'egress',
    subject: 'mcp',
    projectId: options.projectId,
    agentId: options.agentId,
    domains: [url.hostname],
    expiresAt: Date.now() + 60_000,
  });
  const agent = new ProxyAgent({
    uri: options.config.egressProxyUrl,
    token: `Basic ${Buffer.from('sazuz:' + capability).toString('base64')}`,
  });
  if (options.token) {
    secretRedactor.register(options.token);
    secretRedactor.register(`Bearer ${options.token}`);
  }
  const request: FetchLike = async (target, init = {}) => {
    const dest = new URL(target);
    if (dest.href !== url.href || !['GET', 'POST', 'DELETE'].includes(init.method ?? 'GET'))
      throw new McpError('MCP_DENIED');
    const headers = new Headers(init.headers);
    headers.delete('authorization');
    headers.delete('cookie');
    if (options.token) headers.set('authorization', `Bearer ${options.token}`);
    if (init.body && (typeof init.body !== 'string' || Buffer.byteLength(init.body) > 131_072))
      throw new McpError('MCP_INVALID');
    try {
      const requestHeaders: Record<string, string> = {};
      headers.forEach((value, name) => {
        requestHeaders[name] = value;
      });
      const response = await proxyFetch(url, {
        method: init.method ?? 'GET',
        headers: requestHeaders,
        ...(init.body ? { body: String(init.body) } : {}),
        dispatcher: agent,
        redirect: 'error',
        signal: AbortSignal.any([options.signal, ...(init.signal ? [init.signal] : [])]),
      });
      let bytes = 0;
      const reader = response.body?.getReader();
      const body = reader
        ? new ReadableStream<Uint8Array>({
            async pull(controller) {
              const part = await reader.read();
              if (part.done) {
                controller.close();
                return;
              }
              const chunk: unknown = part.value;
              if (!(chunk instanceof Uint8Array)) {
                controller.error(new McpError('MCP_INVALID'));
                return;
              }
              bytes += chunk.byteLength;
              if (bytes > 524_288) {
                controller.error(new McpError('MCP_INVALID'));
                return;
              }
              controller.enqueue(chunk);
            },
            async cancel() {
              await reader.cancel();
            },
          })
        : null;
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        responseHeaders[name] = value;
      });
      return new Response(body, { status: response.status, headers: responseHeaders });
    } catch {
      throw new McpError('MCP_UNAVAILABLE');
    }
  };
  return { fetch: request, close: () => agent.destroy() };
}
