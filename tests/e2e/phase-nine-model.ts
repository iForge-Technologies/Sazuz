import { createServer } from 'node:http';
import { z } from 'zod';
import { browserObservationSchema } from '@sazuz/core/browser';
import { graphPlanSchema } from '@sazuz/core/graphs';
import { learnedProgramSchema, learningLabelsSchema } from '@sazuz/core/learning';
import { styleAnalysisSchema } from '@sazuz/core/skills';

export const phaseNineModelKey = 'sk-phase9-protocol-fixture-428163790';
export const phaseNineStyleTrait = 'Use short concrete sentences and a clear next action.';
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
const plan = graphPlanSchema.parse({
  mode: 'graph',
  deliverable: 'A project review with evidence and open questions.',
  user_checkpoints: [],
  tasks: [
    {
      id: 'research',
      agent: 'researcher',
      depends_on: [],
      goal: 'Review the supplied project evidence and cite sources.',
    },
    {
      id: 'analyze',
      agent: 'analyst',
      depends_on: ['research'],
      goal: 'Summarize project evidence and identify unresolved questions.',
    },
  ].map((task) => ({
    ...task,
    inputs: {},
    acceptance: ['Include evidence and open questions.'],
    budget: { usd: 0.1, steps: 5 },
  })),
});
function untrusted(value: unknown): unknown {
  return JSON.parse(
    z
      .string()
      .parse(value)
      .replace(/^<untrusted>\s*/, '')
      .replace(/\s*<\/untrusted>$/, ''),
  ) as unknown;
}

/** Provider HTTP/SSE fixture for real compiled services. No application route replacement. */
export async function startPhaseNineModel() {
  const host = z
    .enum(['127.0.0.1', 'host.docker.internal'])
    .default('127.0.0.1')
    .parse(process.env.PLAYWRIGHT_MODEL_FIXTURE_HOST);
  const requests: z.infer<typeof requestSchema>[] = [],
    failures: string[] = [],
    categories: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${phaseNineModelKey}`) {
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
        if (source.length > 1000000) throw new Error('Oversized Phase 9 fixture request.');
      }
      const body = requestSchema.parse(JSON.parse(source));
      requests.push(body);
      const system = body.messages
        .filter((message) => message.role === 'system')
        .map((message) => String(message.content))
        .join('\n');
      const user = body.messages.findLast(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.startsWith('<untrusted>'),
      )?.content;
      let category = 'agent',
        text =
          'Evidence: The supplied project record is consistent. Open questions: Confirm the next review date.';
      let next: { name: string; args: unknown } | null = null;
      if (system.includes('Describe this recorded browser procedure')) {
        category = 'recording';
        const input = z
          .object({ site: z.string(), steps: learnedProgramSchema.shape.steps })
          .parse(untrusted(user));
        text = JSON.stringify(
          learningLabelsSchema.parse({
            description: 'Create a project from reviewed inputs and confirm its submission.',
            intents: input.steps
              .flatMap((step) => (step.kind === 'loop' ? step.steps : [step]))
              .map((step) => ({
                id: step.id,
                text: `${step.operation} ${step.target?.name ?? 'the project form'}`,
              })),
          }),
        );
      } else if (system.includes('Select the single current element')) {
        category = 'repair';
        const input = z
          .object({ elements: browserObservationSchema.shape.elements })
          .parse(untrusted(user));
        const target = input.elements.find(
          (element) => element.role === 'button' && element.name === 'Continue to summary',
        );
        text = JSON.stringify({
          ref: target?.ref ?? null,
          reason: 'The unique renamed button continues to the same project summary.',
        });
      } else if (system.includes('Describe only writing style')) {
        category = 'style';
        text = JSON.stringify(
          styleAnalysisSchema.parse({
            traits: [phaseNineStyleTrait],
            greeting: 'Hi team,',
            signOff: 'Thanks,',
            sampleDraft: 'Hi team, please review the agenda before our meeting. Thanks,',
          }),
        );
      } else if (system.includes('Draft only the requested text')) {
        category = 'comparison';
        const input = z
          .object({ task: z.string(), writingStyle: z.string().optional() })
          .parse(untrusted(user));
        text = JSON.stringify({
          draft: input.writingStyle
            ? 'Hi team, the project review is ready. Please check the open questions before Friday. Thanks,'
            : 'The project review is available for consideration. Please review the open questions before Friday.',
        });
      } else if (system.includes('Classify the priority of this notification')) {
        category = 'priority';
        text = JSON.stringify({ priority: 'normal', reason: 'Suitable for the next digest.' });
      } else if (system.includes('independent Auditor')) {
        category = 'audit';
        const input = z
          .object({ acceptance: z.array(z.object({ id: z.string() })) })
          .parse(untrusted(user));
        const check = {
          passed: true,
          reason: 'The fixture result includes the supplied evidence and open questions.',
        };
        text = JSON.stringify({
          criteria: input.acceptance.map((criterion) => ({ id: criterion.id, ...check })),
          grounding: check,
          policy: check,
          tone: check,
          feedback: '',
        });
      } else if (system.includes('Return mode answer')) {
        category = 'plan';
        text = JSON.stringify(plan);
      } else if (body.response_format) {
        category = 'extraction';
        text = JSON.stringify({ candidates: [] });
      } else if (JSON.stringify(body.messages).includes('Phase9 recording bootstrap')) {
        category = 'bootstrap';
        const observations = body.messages.filter((message) => message.role === 'tool');
        const view = observations.length
          ? browserObservationSchema.parse(untrusted(observations.at(-1)?.content))
          : null;
        const profileId = JSON.stringify(body.messages).match(/bpr_[0-9A-HJKMNP-TV-Z]{26}/)?.[0];
        if (!view) next = { name: 'browser.open', args: { profileId } };
        else if (observations.length === 1)
          next = {
            name: 'browser.navigate',
            args: { sessionId: view.sessionId, url: 'https://fixture.example/learn' },
          };
        else {
          const ref = view.elements.find(
            (element) => element.role === 'button' && element.name === 'Review project',
          )?.ref;
          if (!ref) throw new Error('The recording bootstrap form is missing.');
          next = { name: 'browser.click', args: { sessionId: view.sessionId, ref } };
        }
      } else if (system.includes('writingStyle')) {
        category = 'styled-agent';
        text =
          'Hi team, the project review is ready. Please check the open questions before Friday. Thanks,';
      }
      categories.push(category);
      const tool = next
        ? body.tools?.find((entry) => entry.function.description?.startsWith(`${next.name}:`))
        : null;
      if (next && !tool) throw new Error('Expected Phase 9 browser tool is unavailable.');
      const delta =
        next && tool
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `p9-${requests.length}`,
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
          usage: { prompt_tokens: 180, completion_tokens: 120, total_tokens: 300 },
        },
      ])
        response.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-phase9-fixture', model: 'gpt-4o', created: 1793760000, ...event })}\n\n`,
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
  if (!address || typeof address === 'string') throw new Error('The fixture did not bind a port.');
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
