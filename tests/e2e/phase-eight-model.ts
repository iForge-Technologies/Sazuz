import { createServer } from 'node:http';
import { z } from 'zod';
import {
  workflowDefinitionSchema,
  workflowNodeSchema,
  type WorkflowAction,
} from '@sazuz/core/workflows';

export const phaseEightModelKey = 'sk-phase8-protocol-fixture-597186230';
export const phaseEightResultSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
    missingPrerequisites: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'details', 'missingPrerequisites'],
  additionalProperties: false,
};
export function phaseEightGraph(name: string, mixed = false) {
  const steps: { id: string; action: WorkflowAction; input: string }[] = [
    {
      id: 'start',
      action: {
        kind: 'trigger',
        trigger: mixed
          ? { kind: 'cron', expression: '* * * * *', timezone: 'UTC' }
          : { kind: 'manual' },
      },
      input: '$input',
    },
    { id: 'clock', action: { kind: 'tool', agent: 'cos', tool: 'time.now' }, input: '{}' },
  ];
  if (mixed)
    steps.push({
      id: 'summarize',
      action: {
        kind: 'agent',
        agent: 'writer',
        prompt: 'Phase8 summarize the current time from the supplied evidence.',
        outputSchema: phaseEightResultSchema,
      },
      input: '$nodes.clock',
    });
  steps.push({
    id: 'result',
    action: { kind: 'transform', expression: '$input' },
    input: mixed
      ? '$nodes.summarize'
      : '{"zone":$nodes.clock.timeZone,"marker":"Phase8 deterministic output"}',
  });
  return workflowDefinitionSchema.parse({
    name,
    description: 'Production protocol fixture workflow.',
    nodes: steps.map((step, index) =>
      workflowNodeSchema.parse({
        ...step,
        label: step.id,
        position: { x: index * 250, y: 0 },
        retry: { attempts: 1, delaySeconds: 0, timeoutSeconds: 90 },
      }),
    ),
    edges: steps.slice(1).map((step, index) => ({ from: steps[index]!.id, to: step.id })),
  });
}
const requestSchema = z.looseObject({
  messages: z.array(z.looseObject({ role: z.string(), content: z.unknown().optional() })),
  tools: z.array(z.unknown()).optional(),
  response_format: z.unknown().optional(),
});

/** Real provider protocol for the compiled services; no browser/API route substitution. */
export async function startPhaseEightModel() {
  const host = z
    .enum(['127.0.0.1', 'host.docker.internal'])
    .default('127.0.0.1')
    .parse(process.env.PLAYWRIGHT_MODEL_FIXTURE_HOST);
  const requests: z.infer<typeof requestSchema>[] = [],
    failures: string[] = [];
  const categories: ('draft' | 'priority' | 'extraction' | 'agent')[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${phaseEightModelKey}`) {
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
      const system = body.messages
        .filter((message) => message.role === 'system')
        .map((message) => String(message.content))
        .join('\n');
      const category = system.includes('Draft a small Sazuz workflow')
        ? 'draft'
        : system.includes('Classify the priority of this notification')
          ? 'priority'
          : body.response_format
            ? 'extraction'
            : 'agent';
      categories.push(category);
      const result = system.includes('Draft a small Sazuz workflow')
        ? phaseEightGraph('Phase8 generated schedule', true)
        : category === 'priority'
          ? { priority: 'normal', reason: 'The completed source is suitable for a digest.' }
          : body.response_format
            ? { candidates: [] }
            : {
                summary: 'Phase8 verified source summary',
                details: { evidence: 'Supplied workflow node input' },
                missingPrerequisites: [],
              };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        {
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: JSON.stringify(result) },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 180,
            completion_tokens: category === 'priority' ? 50 : 300,
            total_tokens: category === 'priority' ? 230 : 480,
          },
        },
      ])
        response.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-phase8-fixture', model: 'gpt-4o', created: 1793760000, ...event })}\n\n`,
        );
      response.end('data: [DONE]\n\n');
    })().catch(() => {
      failures.push('The Phase 8 model fixture rejected a request.');
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host === '127.0.0.1' ? host : '0.0.0.0', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('The model fixture did not bind a port.');
  return {
    baseUrl: `http://${host}:${address.port}/v1`,
    requests,
    categories,
    failures,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
