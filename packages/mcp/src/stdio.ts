import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpProcess } from '@sazuz/sandbox';
import { McpError } from '@sazuz/core/mcp';
import { boundedJson } from './catalogue.js';

export function containerTransport(
  options: Omit<Parameters<typeof createMcpProcess>[0], 'onData' | 'onError' | 'onClose'>,
): Transport {
  let buffer = Buffer.alloc(0);
  const transport: Transport = {
    start: () => process.start(),
    send: (message) => process.write(JSON.stringify(message) + '\n'),
    close: () => process.close(),
  };
  const fail = () => transport.onerror?.(new McpError('MCP_UNAVAILABLE'));
  const process = createMcpProcess({
    ...options,
    onError: fail,
    onClose: () => transport.onclose?.(),
    onData(data) {
      try {
        buffer = Buffer.concat([buffer, data]);
        if (buffer.length > 524_288) throw new McpError('MCP_INVALID');
        let end: number;
        while ((end = buffer.indexOf(10)) !== -1) {
          const line = buffer.subarray(0, end).toString('utf8');
          buffer = buffer.subarray(end + 1);
          if (!line.trim()) continue;
          const value: unknown = JSON.parse(line);
          boundedJson(value, 524_288, 20);
          transport.onmessage?.(JSONRPCMessageSchema.parse(value));
        }
      } catch {
        fail();
        void process.close().catch(fail);
      }
    },
  });
  return transport;
}
