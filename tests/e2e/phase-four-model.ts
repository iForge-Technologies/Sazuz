import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';

export const phaseFourModelKey = 'sk-phase4-browser-fixture-628749173';
export const preferenceStatement = 'I prefer concise replies.';
export const rememberedPreference = 'Prefers concise replies.';
export const selectedBodyMarker = 'BODY_ONLY_AFTER_SELECTION_ORCHID';
const wireRequest = z.looseObject({
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

/** A real, local HTTP transport fixture; the application still uses its production adapter. */
export async function startPhaseFourModel() {
  const host = z
    .enum(['127.0.0.1', 'host.docker.internal'])
    .default('127.0.0.1')
    .safeParse(process.env.PLAYWRIGHT_MODEL_FIXTURE_HOST);
  if (!host.success) throw new Error('Invalid browser model fixture host.');
  const requests: z.infer<typeof wireRequest>[] = [];
  const failures: string[] = [];
  async function respond(request: IncomingMessage, response: ServerResponse) {
    try {
      if (request.headers.authorization !== `Bearer ${phaseFourModelKey}`) {
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
      const parts: Buffer[] = [];
      let bytes = 0;
      for await (const part of request) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
        bytes += chunk.length;
        if (bytes > 500_000) throw new Error('Fixture request exceeded its limit.');
        parts.push(chunk);
      }
      const body = wireRequest.parse(JSON.parse(Buffer.concat(parts).toString('utf8')));
      requests.push(body);
      const all = JSON.stringify(body.messages),
        format = JSON.stringify(body.response_format ?? {});
      const user = [...body.messages].reverse().find((item) => item.role === 'user');
      const goal = JSON.stringify(user?.content ?? '');
      const observations = body.messages.filter((item) => item.role === 'tool');
      const toolText = JSON.stringify(observations);
      let text = '',
        toolCall: { name: string; args: Record<string, string> } | null = null;
      if (body.response_format) {
        if (format.includes('priority'))
          text = JSON.stringify({ priority: 'normal', reason: 'Suitable for the next digest.' });
        else if (format.includes('candidates'))
          text = JSON.stringify({
            candidates: all.includes(preferenceStatement)
              ? [
                  {
                    kind: 'preference',
                    content: rememberedPreference,
                    quote: preferenceStatement,
                    sensitivity: 'low',
                    importance: 0.7,
                  },
                ]
              : [],
          });
        else if (format.includes('traits'))
          text = JSON.stringify({
            traits: ['Use concise sentences.', 'Begin with the requested action.'],
            greeting: 'Hi',
            signOff: 'Thanks',
            sampleDraft: 'Hi Jo, please review the agenda before tomorrow. Thanks.',
          });
        else text = JSON.stringify({ tasks: [], deliverable: 'A verified concise answer.' });
      } else if (goal.includes('browser-procedure') && !toolText.includes(selectedBodyMarker)) {
        const tool = body.tools?.find((item) =>
          item.function.description?.startsWith('skills.load:'),
        );
        if (!tool) throw new Error('The skill tool was absent.');
        toolCall = { name: tool.function.name, args: { name: 'browser-procedure' } };
      } else if (goal.includes('Orion') || goal.includes('knowledge-qa')) {
        const skill = body.tools?.find((item) =>
          item.function.description?.startsWith('skills.load:'),
        );
        const search = body.tools?.find((item) =>
          item.function.description?.startsWith('kb.search:'),
        );
        const citation = toolText.match(/\[kb:chk_[0-9A-HJKMNP-TV-Z]{26}\]/)?.[0];
        if (citation) text = `Orion launches on 14 November. ${citation}`;
        else if (!observations.length && goal.includes('knowledge-qa') && skill)
          toolCall = { name: skill.function.name, args: { name: 'knowledge-qa' } };
        else if (search) toolCall = { name: search.function.name, args: { query: 'Orion launch' } };
        else throw new Error('The knowledge tool was absent.');
      } else if (goal.includes('browser-procedure'))
        text = 'The selected procedure is now available.';
      else
        text = body.messages.some(
          (item) =>
            item.role === 'system' && JSON.stringify(item.content).includes(rememberedPreference),
        )
          ? 'A concise reply, as you prefer.'
          : 'No saved preference was retrieved.';
      const delta = toolCall
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `phase4-call-${observations.length}`,
                type: 'function',
                function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
              },
            ],
          }
        : { role: 'assistant', content: text };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 180, completion_tokens: 35, total_tokens: 215 },
        },
      ])
        response.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-phase4-fixture', model: 'gpt-4o', created: 1793680000, ...event })}\n\n`,
        );
      response.end('data: [DONE]\n\n');
    } catch {
      failures.push('The local protocol fixture rejected a request.');
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  }
  const server = createServer((request, response) => {
    void respond(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host.data === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture did not bind a local port.');
  return {
    baseUrl: `http://${host.data}:${address.port}/v1`,
    requests,
    failures,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
