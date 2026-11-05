import { createServer } from 'node:http';
import { z } from 'zod';

export const phaseSevenModelKey = 'sk-phase7-protocol-fixture-861972403';
const requestSchema = z.looseObject({
  messages: z.array(z.looseObject({ role: z.string(), content: z.unknown().optional() })),
  tools: z
    .array(
      z.looseObject({
        function: z.looseObject({ name: z.string(), description: z.string().optional() }),
      }),
    )
    .optional(),
  response_format: z.unknown().optional(),
});

/** A local model protocol fixture drives the compiled worker, never a production setting default. */
export async function startPhaseSevenModel() {
  const host = z
    .enum(['127.0.0.1', 'host.docker.internal'])
    .default('127.0.0.1')
    .parse(process.env.PLAYWRIGHT_MODEL_FIXTURE_HOST);
  const requests: z.infer<typeof requestSchema>[] = [],
    failures: string[] = [];
  let deviceId = '';
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${phaseSevenModelKey}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.url === '/v1/models') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
        return;
      }
      if (request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      let source = '';
      for await (const chunk of request) {
        source += String(chunk);
        if (source.length > 1000000) throw new Error('Oversized fixture request.');
      }
      const body = requestSchema.parse(JSON.parse(source));
      requests.push(body);
      const goal = body.messages
        .filter((item) => item.role === 'user')
        .map((item) => String(item.content))
        .join('\n');
      const observations = body.messages.filter((item) => item.role === 'tool');
      let text = 'Phase 7 scoped operation checked.',
        next: { name: string; args: unknown } | null = null;
      if (
        body.messages.some(
          (message) =>
            message.role === 'system' &&
            String(message.content).includes('Classify the priority of this notification'),
        )
      )
        text = JSON.stringify({ priority: 'normal', reason: 'Suitable for the next digest.' });
      else if (body.response_format) text = JSON.stringify({ candidates: [] });
      else if (observations.length === 0 && goal.includes('Phase7')) {
        if (!deviceId) throw new Error('The Bridge fixture has not been paired.');
        next = goal.includes('approved write')
          ? {
              name: 'local.fs.write',
              args: {
                deviceId,
                folder: 'notes',
                path: 'approved.txt',
                content: 'phase7-approved-local-write',
              },
            }
          : {
              name: 'local.fs.read',
              args: {
                deviceId,
                folder: 'notes',
                path: goal.includes('outside path') ? '../outside.txt' : 'marker.txt',
              },
            };
      } else if (JSON.stringify(observations).includes('phase7-production-scoped-marker'))
        text = 'Read phase7-production-scoped-marker from the authorized folder.';
      const tool = next
        ? body.tools?.find((entry) => entry.function.description?.startsWith(`${next.name}:`))
        : null;
      if (next && !tool) throw new Error('Expected Phase 7 tool unavailable.');
      const delta =
        next && tool
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `p7-${requests.length}`,
                  type: 'function',
                  function: { name: tool.function.name, arguments: JSON.stringify(next.args) },
                },
              ],
            }
          : { role: 'assistant', content: text };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: next ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 180, completion_tokens: 45, total_tokens: 225 },
        },
      ])
        response.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-phase7-fixture', model: 'gpt-4o', created: 1793760000, ...event })}\n\n`,
        );
      response.end('data: [DONE]\n\n');
    })().catch(() => {
      failures.push('The Phase 7 model fixture rejected a request.');
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The fixture did not bind a port.');
  return {
    baseUrl: `http://${host}:${address.port}/v1`,
    requests,
    failures,
    useDevice(id: string) {
      deviceId = id;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
