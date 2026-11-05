import { z } from 'zod';
import { missionContext, type Database } from '@sazuz/db';
import { graphPlanSchema, taskAssignmentSchema } from '@sazuz/core/graphs';
import type { ReviewVerdict } from '@sazuz/core/reviews';
import type { ModelRouter, GenerateRequest } from '../../packages/llm/src/index.js';
import type { ExecutionScope } from '../../packages/runtime/src/broker.js';
import { ToolRegistry, defineTool } from '../../packages/tools/src/index.js';
import { createFixtureRouter } from './phase-three-runtime-worker.js';

export const producerReasoningMarker = 'PRODUCER_REASONING_MUST_STAY_OUT_6A7342';
export const reviewDataSchema = z.object({
  goal: z.string(),
  kind: z.enum(['output', 'action']),
  candidate: z.json(),
  acceptance: z.array(z.object({ id: z.string(), criterion: z.string() })),
});
export function reviewData(request: GenerateRequest) {
  const content = request.messages.at(-1)?.content ?? '';
  return reviewDataSchema.parse(
    JSON.parse(content.replace(/^<untrusted>\s*/, '').replace(/\s*<\/untrusted>$/, '')) as unknown,
  );
}
export function fixtureVerdict(request: GenerateRequest, forceReject = false): ReviewVerdict {
  const data = reviewData(request);
  const text = typeof data.candidate === 'string' ? data.candidate : JSON.stringify(data.candidate);
  const check = { passed: true, reason: 'Verified against supplied evidence.' };
  const criteria = data.acceptance.map((criterion) => ({
    id: criterion.id,
    passed:
      !forceReject &&
      !text.includes('unsafe') &&
      (!criterion.criterion.includes('Risks') || text.includes('Risks')),
    reason: forceReject
      ? 'The candidate still omits a required item.'
      : criterion.criterion.includes('Risks') && !text.includes('Risks')
        ? 'Add the missing Risks section.'
        : text.includes('unsafe')
          ? 'Remove the unsafe destination or content.'
          : 'The candidate meets this criterion.',
  }));
  return {
    criteria,
    grounding: check,
    policy: check,
    tone: check,
    feedback: criteria.some((criterion) => !criterion.passed)
      ? 'Include every original criterion, including Risks, and remove unsafe content.'
      : '',
  };
}
export const reviewedPlan = graphPlanSchema.parse({
  mode: 'single',
  deliverable: 'Summary and Risks report',
  user_checkpoints: [],
  tasks: [
    {
      id: 'draft',
      agent: 'writer',
      goal: 'Write a Summary and Risks report.',
      inputs: {},
      depends_on: [],
      acceptance: ['Include Summary', 'Include Risks'],
      budget: { usd: 0.2, steps: 12 },
    },
  ],
});
export function auditorFixture(
  db: Database,
  options: {
    graph?: boolean;
    forceReject?: boolean;
    output?: string;
    action?: boolean;
    initialSafe?: boolean;
  } = {},
) {
  const reviews: GenerateRequest[] = [];
  const generations: GenerateRequest[] = [];
  const replans: GenerateRequest[] = [];
  let sends = 0;
  const tools = new ToolRegistry([
    defineTool({
      name: 'time.review_read',
      description: 'Read the disposable review fixture.',
      input: z.strictObject({}),
      output: z.strictObject({ evidence: z.string() }),
      effect: 'read',
      scope: 'internal',
      untrusted: true,
      privateOnly: () => true,
      run: () =>
        Promise.resolve({
          evidence: 'Project observations support a neutral Summary and explicit Risks.',
        }),
    }),
    defineTool({
      name: 'email.review_send',
      description: 'Send only to the acceptance fixture.',
      input: z.strictObject({ text: z.string().max(1000) }),
      output: z.strictObject({ sent: z.boolean() }),
      effect: 'send',
      scope: 'external',
      untrusted: false,
      run: () => {
        sends++;
        return Promise.resolve({ sent: true });
      },
      verify: () => Promise.resolve({ status: 'done', result: { sent: sends > 0 } }),
    }),
  ]);
  const router = (scope: ExecutionScope): Pick<ModelRouter, 'generate' | 'generateObject'> => ({
    async generateObject<T>(request: GenerateRequest, schema: z.ZodType<T>) {
      if (request.messages[0]?.content.includes('independent Auditor')) {
        reviews.push(request);
        return createFixtureRouter({
          plan: fixtureVerdict(request, options.forceReject),
          costUsd: 0.001,
        }).generateObject(request, schema);
      }
      if (schema.safeParse(reviewedPlan).success)
        return createFixtureRouter({ plan: reviewedPlan, costUsd: 0.001 }).generateObject(
          request,
          schema,
        );
      replans.push(request);
      return createFixtureRouter({
        plan: {
          action: 'revise',
          taskId: 'draft',
          agent: 'writer',
          goal: 'Write the same report with both required sections.',
          reason: 'Repair the missing Risks criterion without changing acceptance.',
        },
        costUsd: 0.001,
      }).generateObject(request, schema);
    },
    async generate(request) {
      generations.push(request);
      const context = (await missionContext(db, scope.runId!))!;
      const assignment = context.run.assignment
        ? taskAssignmentSchema.parse(context.run.assignment)
        : null;
      const observations = request.messages.filter((message) => message.role === 'tool');
      const repaired = request.messages.some((message) =>
        message.content.includes('auditorFeedback'),
      );
      let text =
        options.output ??
        (options.forceReject
          ? 'Summary only.'
          : options.graph && assignment?.attempt === 1
            ? 'Summary only.'
            : 'Summary: Observations checked. Risks: Remaining uncertainty is explicit.');
      const result = await createFixtureRouter({ text, costUsd: 0.001 }).generate(request);
      if (options.graph && assignment && observations.length === 0)
        return {
          ...result,
          text: producerReasoningMarker,
          toolCalls: [{ id: 'read-evidence', name: 'time.review_read', args: {} }],
          finishReason: 'tool-calls',
        };
      if (
        options.action &&
        (observations.length === 0 ||
          (!options.initialSafe &&
            observations.length === 1 &&
            observations[0]!.content.includes('denied')))
      ) {
        text =
          observations.length === 0 && !options.initialSafe
            ? 'unsafe draft'
            : 'Summary and Risks for the approved recipient.';
        return {
          ...result,
          text: producerReasoningMarker,
          toolCalls: [
            { id: `send-${observations.length}`, name: 'email.review_send', args: { text } },
          ],
          finishReason: 'tool-calls',
        };
      }
      if (!options.graph && !options.action && !options.output && !options.forceReject && !repaired)
        return { ...result, text: 'Summary only.' };
      await request.onToken?.(result.text);
      return result;
    },
  });
  return { tools, router, reviews, generations, replans, sends: () => sends };
}
