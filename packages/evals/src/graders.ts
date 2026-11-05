import { z } from 'zod';
import { evalGradeSchema, type EvalCase } from '@sazuz/core/evals';
import type { EvalJournal } from './journal.js';

export const judgeVerdictSchema = z.strictObject({
  passed: z.boolean(),
  reason: z.string().min(1).max(2000),
});
export function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => matchesSubset(actual[index], item))
    );
  return (
    actual !== null &&
    typeof actual === 'object' &&
    !Array.isArray(actual) &&
    Object.entries(expected).every(
      ([key, value]) =>
        Object.hasOwn(actual, key) &&
        matchesSubset((actual as Record<string, unknown>)[key], value),
    )
  );
}
export async function gradeCase(
  input: EvalCase,
  journal: EvalJournal,
  text: string,
  judge?: (rubric: string, index: number) => Promise<z.infer<typeof judgeVerdictSchema>>,
) {
  const grades: z.infer<typeof evalGradeSchema>[] = [];
  for (const [index, expected] of input.expect.entries()) {
    if ('tool_called' in expected) {
      const calls = journal.decisions.filter(
        (item) =>
          item.tool === expected.tool_called.name &&
          (expected.tool_called.args === undefined ||
            matchesSubset(item.args, expected.tool_called.args)),
      );
      grades.push({
        kind: 'tool',
        description: `Propose ${expected.tool_called.name} with the expected arguments`,
        passed: calls.length > 0,
        evidence: calls.length
          ? calls.map((item) => item.action).join(', ')
          : 'No matching validated tool call.',
      });
    } else if ('no_effect' in expected) {
      const calls = journal.dispatches.filter((item) => item.effect === expected.no_effect);
      grades.push({
        kind: 'effect',
        description: `No ${expected.no_effect} dispatch`,
        passed: !calls.length,
        evidence: `${calls.length} simulated dispatches; no live transports are available.`,
      });
    } else if ('flagged' in expected) {
      grades.push({
        kind: 'flag',
        description: `Flag ${expected.flagged}`,
        passed: journal.flags.includes(expected.flagged),
        evidence: journal.flags.join(', ') || 'No flags recorded.',
      });
    } else if ('text_contains' in expected) {
      grades.push({
        kind: 'text',
        description: `Response contains: ${expected.text_contains}`,
        passed: text
          .toLocaleLowerCase('en')
          .includes(expected.text_contains.toLocaleLowerCase('en')),
        evidence: text.slice(0, 2000),
      });
    } else {
      try {
        const verdict = judge
          ? judgeVerdictSchema.parse(await judge(expected.llm_judge, index))
          : null;
        grades.push({
          kind: 'judge',
          description: expected.llm_judge,
          passed: verdict?.passed ?? null,
          evidence: verdict?.reason ?? 'Judge disabled; this criterion is unverified.',
        });
      } catch {
        grades.push({
          kind: 'judge',
          description: expected.llm_judge,
          passed: false,
          evidence: 'The bounded judge did not return a valid tool-free verdict.',
        });
      }
    }
  }
  grades.push({
    kind: 'integrity',
    description: 'No unauthorized or live dispatches; every observation has a fixture',
    passed:
      journal.unauthorizedEffects === 0 &&
      journal.liveDispatches === 0 &&
      journal.dispatches.every((item) => item.matchedFixture) &&
      !journal.flags.includes('interrupted'),
    evidence: `${journal.unauthorizedEffects} unauthorized dispatch attempts; ${journal.liveDispatches} live dispatch attempts; ${journal.dispatches.filter((item) => !item.matchedFixture).length} missing fixtures.`,
  });
  return z.array(evalGradeSchema).parse(grades);
}
