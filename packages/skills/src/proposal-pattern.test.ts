import { describe, expect, it } from 'vitest';
import { secretRedactor } from '@sazuz/vault';
import {
  proposalPattern,
  proposalTerms,
  proposedSkillDocument,
  similarProposalPlans,
} from './proposal-pattern.js';

const goal = 'Prepare the weekly project review from the latest approved sources for 2026-11-04.';
function plan() {
  return {
    mode: 'graph' as const,
    tasks: [
      {
        id: 'research',
        agent: 'researcher',
        goal: 'Research the current project progress and cite the sources.',
        inputs: {},
        depends_on: [],
        acceptance: ['Use current cited project evidence.'],
        budget: { usd: 0.1, steps: 3 },
      },
      {
        id: 'write',
        agent: 'writer',
        goal: 'Write the project review from the collected evidence.',
        inputs: {},
        depends_on: ['research'],
        acceptance: ['Summarize the evidence without unsupported claims.'],
        budget: { usd: 0.1, steps: 3 },
      },
    ],
    user_checkpoints: ['Review before sharing outside the project.'],
    deliverable: 'A cited project review.',
  };
}
describe('Repeated-mission plan comparison', () => {
  it('normalizes case, spacing, Unicode and numeric/date inputs without retaining secret values', () => {
    expect(proposalTerms('Review  CAFÉ on 2026-11-04')).toEqual(
      proposalTerms('review café on 2026-12-20'),
    );
    const secret = 'proposal-pattern-secret-canary-618293';
    secretRedactor.register(secret);
    expect(proposalTerms(`Review the project ${secret}`).join(' ')).not.toContain(secret);
    expect(
      similarProposalPlans(
        proposalPattern(goal, plan())!.fingerprint,
        proposalPattern(goal.replace('2026-11-04', '2026-11-11'), plan())!.fingerprint,
      ),
    ).toBe(true);
  });
  it('requires matching ordered roles, dependencies and human checkpoint structure', () => {
    const original = proposalPattern(goal, plan())!;
    const role = plan();
    role.tasks[0]!.agent = 'analyst';
    const dependency = plan();
    dependency.tasks[1]!.depends_on = [];
    const checkpoint = plan();
    checkpoint.user_checkpoints = [];
    for (const value of [role, dependency, checkpoint])
      expect(
        similarProposalPlans(original.fingerprint, proposalPattern(goal, value)!.fingerprint),
      ).toBe(false);
  });
  it('rejects different goals and acceptance despite matching roles', () => {
    const original = proposalPattern(goal, plan())!;
    const criterion = plan();
    criterion.tasks[1]!.acceptance = ['Publish all results immediately.'];
    const task = plan();
    task.tasks[0]!.goal = 'Delete the old project files and archives.';
    for (const value of [criterion, task])
      expect(
        similarProposalPlans(original.fingerprint, proposalPattern(goal, value)!.fingerprint),
      ).toBe(false);
    expect(
      similarProposalPlans(
        original.fingerprint,
        proposalPattern('Book flights and accommodation for a conference.', plan())!.fingerprint,
      ),
    ).toBe(false);
  });
  it('excludes empty, malformed, cyclic and underspecified plans', () => {
    expect(proposalPattern(goal, {})).toBeNull();
    expect(
      proposalPattern(goal, {
        mode: 'answer',
        tasks: [],
        user_checkpoints: [],
        deliverable: 'Answer',
      }),
    ).toBeNull();
    expect(proposalPattern('Hello', plan())).toBeNull();
    const cyclic = plan();
    cyclic.tasks[0]!.depends_on = ['write'];
    expect(proposalPattern(goal, cyclic)).toBeNull();
  });
  it('retains legacy sequential provenance separately from graph plans', () => {
    const legacy = {
      tasks: [
        {
          agent: 'researcher',
          goal: 'Research the project and cite current evidence.',
          acceptance: ['Cite the source.'],
        },
      ],
      deliverable: 'A short report.',
    };
    const pattern = proposalPattern(goal, legacy)!;
    expect(pattern.fingerprint).toMatchObject({ kind: 'sequential', dependencies: [[]] });
    expect(proposalPattern(goal, { ...legacy, tasks: [] })).toBeNull();
  });
  it('bounds the proposed document and provides fresh inputs without inferring tool grants', () => {
    const value = plan();
    value.tasks[0]!.goal = 'Research '.repeat(800);
    const pattern = proposalPattern(goal, value)!;
    const sources = [1, 2, 3].map((id) => ({
      missionId: `mis_${String(id).padStart(26, '0')}`,
      runId: `run_${String(id).padStart(26, '0')}`,
      planRevision: 1,
      planHash: 'a'.repeat(64),
      goalHash: 'b'.repeat(64),
      privateOnly: true,
    }));
    const document = proposedSkillDocument(goal, pattern, sources, 'c'.repeat(64));
    expect(document.markdown.length).toBeLessThan(24000);
    expect(document.manifest).toMatchObject({
      tools: [],
      permissions: [],
      inputs: { required: ['goal'] },
    });
    expect(document.markdown).toContain('{{context}}');
    expect(document.markdown).toContain('Start after steps: 1.');
    expect(document.markdown).toContain(`/missions/${sources[0]!.missionId}`);
  });
  it('keeps all criteria and source links within the skill limit at the largest valid plan', () => {
    const value = {
      ...plan(),
      tasks: Array.from({ length: 24 }, (_item, index) => ({
        id: `task${index}`,
        agent: 'researcher',
        inputs: {},
        goal: 'Research evidence. '.repeat(500).slice(0, 8000),
        depends_on: Array.from({ length: index }, (_entry, at) => `task${at}`),
        acceptance: Array.from({ length: 10 }, () =>
          'Check current evidence and cite the reviewed sources. '.repeat(30).slice(0, 1000),
        ),
        budget: { usd: 0.1, steps: 3 },
      })),
      user_checkpoints: Array.from({ length: 10 }, () =>
        'Review before sharing outside the project. '.repeat(20).slice(0, 500),
      ),
    };
    const pattern = proposalPattern(goal, value)!;
    expect(pattern).not.toBeNull();
    const sources = [1, 2, 3].map((id) => ({
      missionId: `mis_${String(id).padStart(26, '0')}`,
      runId: `run_${String(id).padStart(26, '0')}`,
      planRevision: 1,
      planHash: 'a'.repeat(64),
      goalHash: 'b'.repeat(64),
      privateOnly: true,
    }));
    const document = proposedSkillDocument(goal, pattern, sources, 'd'.repeat(64));
    expect(document.markdown.length).toBeLessThanOrEqual(24000);
    expect(document.markdown.match(/- Check:/g)).toHaveLength(240);
    expect(document.markdown).toContain(sources[2]!.missionId);
  });
});
