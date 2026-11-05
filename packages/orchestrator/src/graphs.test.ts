import { describe, expect, it } from 'vitest';
import { graphPlanSchema, replanSchema, taskAssignmentSchema } from '@sazuz/core/graphs';

const task = {
  id: 'a',
  agent: 'researcher',
  goal: 'Collect sources',
  inputs: {},
  depends_on: [],
  acceptance: ['Include a source'],
  budget: { usd: 0.1, steps: 5 },
};
const plan = {
  mode: 'graph',
  tasks: [task, { ...task, id: 'b', depends_on: ['a'] }],
  user_checkpoints: [],
  deliverable: 'A cited answer',
};
describe('bounded Chief of Staff DAG contracts', () => {
  it('accepts answer, single and branching graph plans', () => {
    expect(graphPlanSchema.parse(plan).tasks).toHaveLength(2);
    expect(graphPlanSchema.parse({ ...plan, mode: 'single', tasks: [task] }).mode).toBe('single');
    expect(graphPlanSchema.parse({ ...plan, mode: 'answer', tasks: [] }).tasks).toHaveLength(0);
  });
  it.each([
    { ...plan, tasks: [task, task] },
    { ...plan, tasks: [task, { ...task, id: 'b', depends_on: ['missing'] }] },
    {
      ...plan,
      tasks: [
        { ...task, depends_on: ['b'] },
        { ...task, id: 'b', depends_on: ['a'] },
      ],
    },
    { ...plan, tasks: [task, { ...task, id: 'b', depends_on: ['a', 'a'] }] },
    { ...plan, mode: 'single' },
    { ...plan, mode: 'answer' },
    { ...plan, tasks: [{ ...task, acceptance: [] }] },
    { ...plan, tasks: Array.from({ length: 25 }, (_, index) => ({ ...task, id: 'task' + index })) },
    { ...plan, tasks: [task, { ...task, id: 'b', agent: 'auditor' }] },
    { ...plan, tasks: [task, { ...task, id: 'b', inputs: { data: 'x'.repeat(13000) } }] },
  ])('rejects invalid IDs, dependencies, cycles, modes, actors or unbounded data (%#)', (value) => {
    expect(graphPlanSchema.safeParse(value).success).toBe(false);
  });
  it('does not let replans replace acceptance, budgets, dependencies or all tasks', () => {
    const revision = {
      action: 'revise',
      taskId: 'a',
      agent: 'writer',
      goal: 'Fix the original task',
      reason: 'Missing a source',
    };
    expect(replanSchema.parse(revision).action).toBe('revise');
    for (const extra of [
      { acceptance: [] },
      { budget: { usd: 100 } },
      { depends_on: [] },
      { tasks: [] },
    ])
      expect(replanSchema.safeParse({ ...revision, ...extra }).success).toBe(false);
    expect(
      replanSchema.safeParse({ action: 'ask_user', question: 'Which source should I use?' })
        .success,
    ).toBe(true);
    expect(taskAssignmentSchema.safeParse({ attempt: 4 }).success).toBe(false);
  });
});
