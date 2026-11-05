import { createServer } from 'node:http';
import { z } from 'zod';
import { browserObservationSchema } from '@sazuz/core/browser';

export const phaseFiveModelKey = 'sk-phase5-protocol-fixture-7916284';
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
export async function startPhaseFiveModel() {
  const requests: z.infer<typeof requestSchema>[] = [];
  const failures: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${phaseFiveModelKey}`) {
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
        if (source.length > 1000000) throw new Error('Oversized model fixture request.');
      }
      const body = requestSchema.parse(JSON.parse(source));
      requests.push(body);
      const observations = body.messages.filter((message) => message.role === 'tool');
      const last = observations.at(-1);
      const value =
        typeof last?.content === 'string'
          ? last.content.replace(/^<untrusted>\s*/, '').replace(/\s*<\/untrusted>$/, '')
          : undefined;
      const view =
        value && !body.response_format
          ? browserObservationSchema.parse(JSON.parse(value))
          : undefined;
      const ref = (name: string) => {
        const element = view?.elements.find((element) => element.name.includes(name));
        if (!element) throw new Error('Expected form control is missing.');
        return element.ref;
      };
      const profileId = JSON.stringify(body.messages).match(/bpr_[0-9A-HJKMNP-TV-Z]{26}/)?.[0];
      const sessionId = view?.sessionId;
      const step = observations.length;
      const next = body.response_format
        ? null
        : step === 0
          ? { name: 'browser.open', args: { profileId } }
          : step === 1
            ? {
                name: 'browser.navigate',
                args: { sessionId, url: 'https://fixture.example/login' },
              }
            : step === 2
              ? { name: 'browser.read', args: { sessionId } }
              : step === 3
                ? {
                    name: 'browser.type',
                    args: {
                      sessionId,
                      ref: ref('Project name'),
                      value: { text: 'Launch project' },
                    },
                  }
                : step === 4
                  ? {
                      name: 'browser.select',
                      args: { sessionId, ref: ref('Region'), values: ['West'] },
                    }
                  : step === 5
                    ? { name: 'browser.click', args: { sessionId, ref: ref('Review') } }
                    : step === 6
                      ? { name: 'browser.click', args: { sessionId, ref: ref('Submit project') } }
                      : step === 7
                        ? { name: 'browser.screenshot', args: { sessionId } }
                        : null;
      const tool = next
        ? body.tools?.find((tool) => tool.function.description?.startsWith(`${next.name}:`))
        : null;
      if (next && !tool) throw new Error('Expected browser tool is missing.');
      const text = body.response_format
        ? JSON.stringify(
            body.messages.some(
              (message) =>
                message.role === 'system' &&
                String(message.content).includes('Classify the priority of this notification'),
            )
              ? { priority: 'normal', reason: 'Suitable for the next digest.' }
              : { candidates: [] },
          )
        : 'Project submitted: fixture-42.';
      const delta =
        next && tool
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `p5-${step}`,
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
          usage: { prompt_tokens: 180, completion_tokens: 35, total_tokens: 215 },
        },
      ])
        response.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-phase5-fixture', model: 'gpt-4o', created: 1793680000, ...event })}\n\n`,
        );
      response.end('data: [DONE]\n\n');
    })().catch(() => {
      failures.push('The form model fixture rejected a request.');
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('The model fixture did not bind a port.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    failures,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
