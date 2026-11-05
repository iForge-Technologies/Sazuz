import { createServer } from 'node:http';
import { z } from 'zod';
import { builtinSuites } from '../../packages/evals/src/index.js';

export const phaseTenModelKey = 'sk-phase10-protocol-fixture-942186703';
export const phaseTenCollectorKey = 'phase10-collector-fixture-719854632';
const inputSchema = z.looseObject({
  model: z.string(),
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

/** Local HTTP/SSE protocol fixture: production services, policy and persistence stay real. */
export async function startPhaseTenModel() {
  const host = z
    .enum(['127.0.0.1', 'host.docker.internal'])
    .default('127.0.0.1')
    .parse(process.env.PLAYWRIGHT_MODEL_FIXTURE_HOST);
  const requests: z.infer<typeof inputSchema>[] = [];
  const failures: string[] = [];
  const collected: { authorized: boolean; payload: unknown }[] = [];
  const cases = builtinSuites(true).flatMap((suite) => suite.cases);
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/v1/traces') {
        let content = '';
        for await (const chunk of request) {
          content += String(chunk);
          if (content.length > 1_000_000) throw new Error('Oversized collector fixture request.');
        }
        collected.push({
          authorized: request.headers.authorization === `Bearer ${phaseTenCollectorKey}`,
          payload: JSON.parse(content) as unknown,
        });
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ignored: phaseTenCollectorKey }));
        return;
      }
      if (request.headers.authorization !== `Bearer ${phaseTenModelKey}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.url === '/v1/models') {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }));
        return;
      }
      if (request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      let content = '';
      for await (const chunk of request) {
        content += String(chunk);
        if (content.length > 1_000_000) throw new Error('Oversized Phase 10 model request.');
      }
      const body = inputSchema.parse(JSON.parse(content));
      requests.push(body);
      const system = body.messages
        .filter((message) => message.role === 'system')
        .map((message) => String(message.content))
        .join('\n');
      const task = cases.find((item) =>
        body.messages.some((message) => message.role === 'user' && message.content === item.task),
      );
      let text = 'Comparable Phase10 fixture summary: the recorded note is ready.';
      let calls: { name: string; args: unknown }[] = [];
      if (system.includes('Grade the response against the rubric'))
        text = JSON.stringify({
          passed: true,
          reason: 'The fixture response and required review boundary satisfy the task.',
        });
      else if (task) {
        const turn =
          task.fixtureTurns[body.messages.filter((message) => message.role === 'assistant').length];
        if (!turn) throw new Error('The evaluation fixture turn is unavailable.');
        text = turn.text;
        calls = turn.toolCalls;
      } else if (system.includes('Classify the priority of this notification'))
        text = JSON.stringify({ priority: 'normal', reason: 'Suitable for digest delivery.' });
      else if (body.response_format) text = JSON.stringify({ candidates: [] });
      else if (
        JSON.stringify(body.messages).includes('Phase10 replay source') &&
        !body.messages.some((message) => message.role === 'tool')
      )
        calls = [
          {
            name: 'files.write',
            args: { path: 'phase10-note.txt', content: 'Original Phase10 fixture note.' },
          },
        ];
      const toolCalls = calls.map((call, index) => {
        const tool = body.tools?.find((entry) =>
          entry.function.description?.startsWith(`${call.name}:`),
        );
        if (!tool) throw new Error('The expected Phase 10 tool is unavailable.');
        return {
          index,
          id: `p10-${requests.length}-${index}`,
          type: 'function',
          function: { name: tool.function.name, arguments: JSON.stringify(call.args) },
        };
      });
      const delta = toolCalls.length
        ? { role: 'assistant', tool_calls: toolCalls }
        : { role: 'assistant', content: text };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        {
          choices: [
            { index: 0, delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' },
          ],
          usage: { prompt_tokens: 180, completion_tokens: 120, total_tokens: 300 },
        },
      ])
        response.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-phase10-fixture', model: body.model, created: 1793836800, ...event })}\n\n`,
        );
      response.end('data: [DONE]\n\n');
    })().catch((error: unknown) => {
      failures.push(
        error instanceof z.ZodError
          ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.code}`).join('; ')
          : error instanceof Error
            ? error.name
            : 'Unknown fixture failure',
      );
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host === '127.0.0.1' ? host : '0.0.0.0', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The fixture did not bind.');
  return {
    baseUrl: `http://${host}:${address.port}/v1`,
    collectorUrl: `http://${host}:${address.port}/v1/traces`,
    requests,
    failures,
    collected,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
