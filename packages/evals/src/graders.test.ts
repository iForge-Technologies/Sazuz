import { expect, it } from 'vitest';
import { evalCaseSchema } from '@sazuz/core/evals';
import { gradeCase, matchesSubset } from './graders.js';
import { newJournal } from './journal.js';

it('compares partial objects precisely and distinguishes a denied proposal from a dispatch', async () => {
  expect(matchesSubset({ target: { id: 3, other: true } }, { target: { id: 3 } })).toBe(true);
  expect(matchesSubset({ target: null }, { target: { id: 3 } })).toBe(false);
  expect(matchesSubset([1, 2], [1])).toBe(false);
  expect(matchesSubset([1, 2], [1, 2])).toBe(true);
  const journal = newJournal();
  journal.decisions.push({
    callId: 'call',
    tool: 'gmail.send',
    args: { to: ['person@example.test'] },
    effect: 'send',
    action: 'deny',
    ruleId: 'scope',
    tainted: true,
  });
  const input = evalCaseSchema.parse({
    id: 'case',
    task: 'Triage.',
    tools: ['gmail.send'],
    fixtures: [],
    fixtureTurns: [{ text: 'Review.' }],
    expect: [
      { tool_called: { name: 'gmail.send', args: { to: ['person@example.test'] } } },
      { no_effect: 'send' },
    ],
  });
  expect((await gradeCase(input, journal, 'Review.')).every((grade) => grade.passed)).toBe(true);
  journal.dispatches.push({
    key: 'simulated',
    tool: 'gmail.send',
    args: {},
    effect: 'send',
    matchedFixture: true,
  });
  expect((await gradeCase(input, journal, 'Review.'))[1]?.passed).toBe(false);
});
