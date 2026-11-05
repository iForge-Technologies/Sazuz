import { createServer } from 'node:http';
import { z } from 'zod';
import { graphPlanSchema } from '@sazuz/core/graphs';

export const phaseSixModelKey = 'sk-phase6-protocol-fixture-9073164';
export const phaseSixReasoning = 'PHASE6_PRODUCER_REASONING_594813';
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
  deliverable: 'Phase 6 Summary and Risks report',
  user_checkpoints: [],
  tasks: [
    { id: 'collect', agent: 'researcher', depends_on: [] },
    { id: 'inspect', agent: 'analyst', depends_on: [] },
    { id: 'draft', agent: 'writer', depends_on: ['collect'] },
    { id: 'analyze', agent: 'coder', depends_on: ['inspect'] },
    { id: 'merge', agent: 'writer', depends_on: ['draft', 'analyze'] },
  ].map((task) => ({
    ...task,
    goal: `Phase6 ${task.id} task: produce Summary and Risks.`,
    inputs: {},
    acceptance: ['Include Summary', 'Include Risks'],
    budget: { usd: 0.2, steps: 10 },
  })),
});
export async function startPhaseSixModel() {
  const host = z
    .enum(['127.0.0.1', 'host.docker.internal'])
    .default('127.0.0.1')
    .parse(process.env.PLAYWRIGHT_MODEL_FIXTURE_HOST);
  const requests: z.infer<typeof requestSchema>[] = [],
    failures: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${phaseSixModelKey}`) {
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
      const system = typeof body.messages[0]?.content === 'string' ? body.messages[0].content : '';
      const data = body.messages
        .filter((message) => message.role === 'user')
        .map((message) => String(message.content))
        .join('\n');
      const observations = body.messages.filter((message) => message.role === 'tool');
      let text = 'Summary: All five tasks are complete. Risks: Remaining uncertainty is explicit.';
      let next: { name: string; args: unknown } | null = null;
      if (system.includes('Classify the priority of this notification'))
        text = JSON.stringify({ priority: 'normal', reason: 'Suitable for the next digest.' });
      else if (system.includes('independent Auditor')) {
        const reviewInput = z
          .string()
          .parse(body.messages.find((message) => message.role === 'user')?.content);
        const review = z
          .object({
            candidate: z.json(),
            acceptance: z.array(z.object({ id: z.string(), criterion: z.string() })),
          })
          .parse(
            JSON.parse(
              reviewInput.replace(/^<untrusted>\s*/, '').replace(/\s*<\/untrusted>$/, ''),
            ) as unknown,
          );
        const candidate =
          typeof review.candidate === 'string'
            ? review.candidate
            : JSON.stringify(review.candidate);
        const check = { passed: true, reason: 'The supplied evidence supports this check.' };
        const criteria = review.acceptance.map((criterion) => ({
          id: criterion.id,
          passed: !criterion.criterion.includes('Risks') || candidate.includes('Risks'),
          reason:
            criterion.criterion.includes('Risks') && !candidate.includes('Risks')
              ? 'The required Risks section is missing.'
              : 'The required section is present.',
        }));
        text = JSON.stringify({
          criteria,
          grounding: check,
          policy: check,
          tone: check,
          feedback: criteria.some((criterion) => !criterion.passed)
            ? 'Add the missing Risks section while keeping the original scope.'
            : '',
        });
      } else if (system.includes('Revise only the failed task'))
        text = JSON.stringify({
          action: 'revise',
          taskId: 'draft',
          agent: 'writer',
          goal: 'Repair Phase6 draft task with both Summary and Risks.',
          reason: 'Repair the omitted Risks section without changing acceptance.',
        });
      else if (system.includes('Return mode answer')) text = JSON.stringify(plan);
      else if (body.response_format) text = JSON.stringify({ candidates: [] });
      else {
        const key = data.match(/Phase6 (collect|inspect|draft|analyze|merge) task/)?.[1];
        if (key && observations.length === 0) next = { name: 'time.now', args: {} };
        else if (key === 'collect' && observations.length === 1)
          next = {
            name: 'blackboard.append',
            args: { text: 'Sources reviewed; preserve uncertainty in Risks.', artifacts: [] },
          };
        else if (key === 'draft' && !data.includes('Repair Phase6'))
          text = 'Summary: The requested observations have been collected.';
        else if (key)
          text = `Summary: ${key} observations checked. Risks: Limitations are explicit.`;
      }
      const tool = next
        ? body.tools?.find((entry) => entry.function.description?.startsWith(`${next.name}:`))
        : null;
      if (next && !tool) throw new Error('Expected Phase 6 tool unavailable.');
      const delta =
        next && tool
          ? {
              role: 'assistant',
              content: phaseSixReasoning,
              tool_calls: [
                {
                  index: 0,
                  id: `p6-${requests.length}`,
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
          `data: ${JSON.stringify({ id: 'chatcmpl-phase6-fixture', model: 'gpt-4o', created: 1793760000, ...event })}\n\n`,
        );
      response.end('data: [DONE]\n\n');
    })().catch(() => {
      failures.push('The Phase 6 model fixture rejected a request.');
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
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
