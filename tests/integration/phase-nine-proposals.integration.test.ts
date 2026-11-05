import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshSettings } from '@sazuz/config/settings';
import {
  auditLog,
  costLedger,
  createMission,
  createProject,
  getMission,
  graphRevisions,
  missionGraphs,
  missions,
  missionTasks,
  projects,
  runs,
  skillProposals,
  skills,
  users,
  valueHash,
  workKey,
} from '@sazuz/db';
import { skillProposalSchema } from '@sazuz/core/proposals';
import {
  decideSkillProposal,
  detectSkillProposal,
  listSkillProposals,
  parseSkill,
  proposalPattern,
  saveSkill,
  skillVersion,
} from '../../packages/skills/src/index.js';
import { ToolRegistry } from '../../packages/tools/src/index.js';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { createFixtureRouter } from './phase-three-runtime-worker.js';
import { phaseFourFixture } from './phase-four-fixture.js';

function goal(day = 4) {
  return `Prepare the weekly project review from the latest approved sources for 2026-11-${day}.`;
}
function plan() {
  return {
    tasks: [
      {
        agent: 'researcher' as const,
        goal: 'Research the current project evidence and cite its sources.',
        acceptance: ['Cite current source material.'],
      },
      {
        agent: 'analyst' as const,
        goal: 'Summarize the project evidence and identify unresolved questions.',
        acceptance: ['Include evidence and open questions.'],
      },
    ],
    deliverable: 'A cited project review with unresolved questions.',
  };
}
function graph() {
  return {
    mode: 'graph',
    tasks: plan().tasks.map((task, i) => ({
      ...task,
      id: `task${i}`,
      inputs: {},
      depends_on: i ? [`task${i - 1}`] : [],
      budget: { usd: 0.1, steps: 3 },
    })),
    user_checkpoints: [],
    deliverable: plan().deliverable,
  };
}

describe('Phase 9 repeated-mission skill proposals', () => {
  let f: Awaited<ReturnType<typeof phaseFourFixture>>, projectId: string;
  beforeAll(async () => {
    f = await phaseFourFixture();
  });
  beforeEach(async () => {
    await f.db.orm.delete(skills).where(eq(skills.userId, f.userId));
    await f.db.orm.delete(projects).where(eq(projects.userId, f.userId));
    await f.db.orm.delete(costLedger);
    projectId = (await createProject(f.db, f.userId, { name: 'Repeated mission project' })).id;
  });
  afterAll(async () => {
    await f?.close();
  });
  function mission(
    options: { project?: string; owner?: string; goal?: string; agent?: 'cos' | 'researcher' } = {},
  ) {
    return createMission(
      f.db,
      options.owner ?? f.userId,
      {
        projectId: options.project ?? projectId,
        goal: options.goal ?? goal(),
        agent: options.agent ?? 'cos',
        requestId: randomUUID(),
      },
      { maxSteps: 15, maxCostUsd: 1, maxWallTimeSeconds: 180 },
    );
  }
  async function completed(
    options: {
      project?: string;
      owner?: string;
      goal?: string;
      status?: string;
      source?: string;
      privateOnly?: boolean;
      rawPlan?: unknown;
      graph?: boolean;
      agent?: 'cos' | 'researcher';
      old?: boolean;
    } = {},
  ) {
    const value = await mission(options);
    const definition = options.rawPlan ?? (options.graph ? graph() : plan());
    await f.db.orm
      .update(runs)
      .set({
        status: options.status ?? 'completed',
        checkpoint: {
          phase: 'done',
          loop: { privateOnly: options.privateOnly ?? false },
          plan: options.graph ? null : definition,
          results: options.graph
            ? []
            : plan().tasks.map((task) => ({
                agent: task.agent,
                text: 'Fixture result with evidence.',
                tainted: true,
              })),
        },
      })
      .where(eq(runs.id, value.run.id));
    if (options.source || options.old)
      await f.db.orm
        .update(missions)
        .set({
          ...(options.source ? { source: options.source } : {}),
          ...(options.old ? { createdAt: new Date(Date.now() - 91 * 86400000) } : {}),
        })
        .where(eq(missions.id, value.id));
    if (options.graph) {
      const definition = graph();
      await f.db.orm
        .insert(missionGraphs)
        .values({ missionId: value.id, rootRunId: value.run.id, revision: 1, definition });
      await f.db.orm.insert(graphRevisions).values({
        id: workKey('grv'),
        missionId: value.id,
        revision: 1,
        definition,
        reason: 'Fixture initial plan.',
      });
      for (const task of definition.tasks) {
        const runId = workKey('run');
        await f.db.orm.insert(runs).values({
          id: runId,
          missionId: value.id,
          parentRunId: value.run.id,
          agentId: task.agent,
          status: 'completed',
          limits: { maxSteps: 3, maxCostUsd: 0.1, maxWallTimeSeconds: 180 },
        });
        await f.db.orm.insert(missionTasks).values({
          id: workKey('tsk'),
          missionId: value.id,
          taskKey: task.id,
          definition: task,
          status: 'completed',
          runId,
          result: {
            taskId: task.id,
            agent: task.agent,
            text: 'Completed with evidence.',
            tainted: true,
            privateOnly: options.privateOnly ?? false,
          },
        });
      }
    }
    return value;
  }
  function detect(id: string, project = projectId, owner = f.userId) {
    return f.db.orm.transaction((tx) =>
      detectSkillProposal(tx, { userId: owner, projectId: project, missionId: id }),
    );
  }
  async function proposed(privateOnly = false) {
    const values = [];
    for (const day of [4, 11, 18]) values.push(await completed({ goal: goal(day), privateOnly }));
    expect(await detect(values[2]!.id)).not.toBeNull();
    return (await listSkillProposals(f.db, f.userId, projectId))[0]!;
  }
  it('creates one inert proposal after three real durable CoS completions without a completion callback or extra inference', async () => {
    let generated = 0;
    const runner = createDurableExecutor({
      database: f.db,
      workerId: workKey('wrk'),
      dataDir: f.directory,
      getSettings: freshSettings,
      tools: new ToolRegistry(),
      router: () =>
        createFixtureRouter({
          plan: plan(),
          costUsd: 0.001,
          onGenerate: () => {
            generated++;
          },
        }),
    });
    const ids: string[] = [];
    for (const day of [4, 11, 18]) {
      const value = await mission({ goal: goal(day) });
      ids.push(value.id);
      await runner.execute(value.run.id);
      expect((await getMission(f.db, f.userId, value.id))?.mission.run.status).toBe('completed');
      const proposals = await listSkillProposals(f.db, f.userId, projectId);
      expect(proposals).toHaveLength(ids.length < 3 ? 0 : 1);
    }
    const [proposal] = await listSkillProposals(f.db, f.userId, projectId);
    expect(proposal?.sources.map((source) => source.missionId).sort()).toEqual(ids.sort());
    expect(proposal?.status).toBe('proposed');
    expect(parseSkill(proposal!.markdown).manifest).toMatchObject({ permissions: [], tools: [] });
    expect(await f.db.orm.select().from(skills).where(eq(skills.userId, f.userId))).toHaveLength(0);
    const before = generated,
      costs = await f.db.orm.select().from(costLedger).where(eq(costLedger.projectId, projectId));
    await Promise.all(ids.map((id) => detect(id)));
    expect(generated).toBe(before);
    expect(
      await f.db.orm.select().from(costLedger).where(eq(costLedger.projectId, projectId)),
    ).toEqual(costs);
    expect(await listSkillProposals(f.db, f.userId, projectId)).toHaveLength(1);
  });
  it('does not combine failed, old, direct, learned, workflow or unrelated-owner/project missions', async () => {
    const other = workKey('usr');
    await f.db.orm
      .insert(users)
      .values({ id: other, name: 'Other owner', email: `${other}@example.test` });
    const foreign = await createProject(f.db, other, { name: 'Other owner project' });
    const separate = await createProject(f.db, f.userId, { name: 'Other owned project' });
    for (const options of [
      { status: 'failed' },
      { status: 'paused' },
      { old: true },
      { source: 'workflow' },
      { source: 'learned-skill' },
      { agent: 'researcher' as const },
      { project: separate.id },
      { project: foreign.id, owner: other },
      { rawPlan: { tasks: [], deliverable: 'Answer only.' } },
    ])
      await completed(options);
    const first = await completed(),
      second = await completed();
    expect(await detect(first.id)).toBeNull();
    expect(await detect(second.id)).toBeNull();
    expect(await detect(second.id, projectId, other)).toBeNull();
    expect(await listSkillProposals(f.db, f.userId, projectId)).toEqual([]);
    await f.db.orm.delete(users).where(eq(users.id, other));
  });
  it('requires successful graph tasks and excludes different plan goals', async () => {
    const a = await completed({ graph: true }),
      b = await completed({ graph: true }),
      c = await completed({ graph: true });
    await f.db.orm
      .update(missionTasks)
      .set({ status: 'failed' })
      .where(eq(missionTasks.missionId, b.id));
    expect(await detect(c.id)).toBeNull();
    await f.db.orm
      .update(missionTasks)
      .set({ status: 'completed' })
      .where(eq(missionTasks.missionId, b.id));
    await f.db.orm
      .update(missionTasks)
      .set({
        result: {
          taskId: 'task0',
          agent: 'researcher',
          text: 'Completed with private evidence.',
          tainted: true,
          privateOnly: true,
        },
      })
      .where(and(eq(missionTasks.missionId, a.id), eq(missionTasks.taskKey, 'task0')));
    expect(await detect(c.id)).not.toBeNull();
    const [proposal] = await listSkillProposals(f.db, f.userId, projectId);
    expect(proposal?.sources.every((source) => source.planRevision === 1)).toBe(true);
    expect(proposal?.privateOnly).toBe(true);
    expect(proposal?.sources.map((source) => source.missionId).sort()).toEqual(
      [a.id, b.id, c.id].sort(),
    );
    const changed = plan();
    changed.tasks[0]!.goal = 'Remove every obsolete project directory after review.';
    const d = await completed({ rawPlan: changed });
    expect(await detect(d.id)).toBeNull();
  });
  it('rolls back proposal creation with completion, then deduplicates concurrent retries and rejected families', async () => {
    const a = await completed(),
      b = await completed(),
      c = await completed();
    await expect(
      f.db.orm.transaction(async (tx) => {
        expect(
          await detectSkillProposal(tx, { userId: f.userId, projectId, missionId: c.id }),
        ).not.toBeNull();
        throw new Error('Simulated completion transaction failure.');
      }),
    ).rejects.toThrow('Simulated completion');
    expect(await listSkillProposals(f.db, f.userId, projectId)).toEqual([]);
    const result = await Promise.all([detect(a.id), detect(b.id), detect(c.id)]);
    expect(result.filter(Boolean)).toHaveLength(1);
    const proposal = (await listSkillProposals(f.db, f.userId, projectId))[0]!;
    const rejected = await decideSkillProposal(f.db, f.userId, proposal.id, { action: 'reject' });
    expect(rejected.status).toBe('rejected');
    expect(await decideSkillProposal(f.db, f.userId, proposal.id, { action: 'reject' })).toEqual(
      rejected,
    );
    const later = await completed({ goal: goal(25) });
    expect(await detect(later.id)).toBeNull();
    await expect(
      decideSkillProposal(f.db, f.userId, proposal.id, {
        action: 'accept',
        markdown: proposal.markdown,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_CONFLICT' });
    expect(await listSkillProposals(f.db, f.userId, projectId)).toHaveLength(1);
    expect(
      await f.db.orm
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.target, proposal.id), eq(auditLog.action, 'skill.proposal.created')),
        ),
    ).toHaveLength(1);
  });
  it('accepts an edited immutable skill only explicitly and preserves private provenance on later edits', async () => {
    const proposal = await proposed(true),
      originalSources = proposal.sources;
    const markdown =
      proposal.markdown.replace(/^name:.*$/m, 'name: reviewed-project-review') +
      '\nOwner-reviewed wording.\n';
    const body = { action: 'accept', markdown, enabled: true, privateOnly: false };
    const [first, second] = await Promise.all([
      decideSkillProposal(f.db, f.userId, proposal.id, body),
      decideSkillProposal(f.db, f.userId, proposal.id, body),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: 'accepted',
      privateOnly: true,
      revision: 1,
      sources: originalSources,
    });
    const skill = await skillVersion(f.db, f.userId, first.skillId!);
    expect(skill).toMatchObject({
      name: 'reviewed-project-review',
      source: 'proposed',
      enabled: true,
      privateOnly: true,
    });
    const edit = await saveSkill(
      f.db,
      f.userId,
      {
        markdown: skill.markdown + '\nReviewed another time.\n',
        expectedRevision: 1,
        privateOnly: false,
      },
      skill.id,
    );
    expect(edit).toMatchObject({ source: 'proposed', revision: 2, privateOnly: true });
    expect((await skillVersion(f.db, f.userId, skill.id, 1)).sha256).toBe(skill.sha256);
    expect((await listSkillProposals(f.db, f.userId, projectId))[0]?.sources).toEqual(
      originalSources,
    );
  });
  it('honors tighter current project privacy, unavailable sources and reserved style names', async () => {
    const proposal = await proposed();
    const reserved = proposal.markdown.replace(/^name:.*$/m, 'name: writing-style');
    await expect(
      decideSkillProposal(f.db, f.userId, proposal.id, { action: 'accept', markdown: reserved }),
    ).rejects.toMatchObject({ code: 'SKILL_CONFLICT' });
    await f.db.orm
      .update(runs)
      .set({ status: 'failed' })
      .where(eq(runs.id, proposal.sources[0]!.runId));
    await expect(
      decideSkillProposal(f.db, f.userId, proposal.id, {
        action: 'accept',
        markdown: proposal.markdown,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_CONFLICT' });
    await f.db.orm
      .update(runs)
      .set({ status: 'completed' })
      .where(eq(runs.id, proposal.sources[0]!.runId));
    const accepted = await decideSkillProposal(f.db, f.userId, proposal.id, {
      action: 'accept',
      markdown: proposal.markdown,
      privateOnly: false,
    });
    expect((await skillVersion(f.db, f.userId, accepted.skillId!)).privateOnly).toBe(false);
    await f.db.orm.update(projects).set({ privacy: 'private' }).where(eq(projects.id, projectId));
    expect((await skillVersion(f.db, f.userId, accepted.skillId!)).privateOnly).toBe(true);
  });
  it('enforces API ownership, CSRF, schema and immutable source IDs', async () => {
    const proposal = await proposed();
    const response = await f.request('GET', `/api/skills/proposals?projectId=${projectId}`);
    expect(response.statusCode).toBe(200);
    expect(skillProposalSchema.array().parse(response.json())[0]?.sources).toEqual(
      proposal.sources,
    );
    expect(
      (await f.request('GET', `/api/skills/proposals?projectId=${projectId}`, undefined, false))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await f.request(
          'POST',
          `/api/skills/proposals/${proposal.id}/decision`,
          { action: 'reject' },
          true,
          'https://foreign.example',
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.request('POST', `/api/skills/proposals/${proposal.id}/decision`, {
          action: 'accept',
          markdown: proposal.markdown,
          sources: [],
        })
      ).statusCode,
    ).toBe(400);
    await expect(
      decideSkillProposal(f.db, 'another-owner', proposal.id, { action: 'reject' }),
    ).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
    expect(
      (
        await f.request('POST', `/api/skills/proposals/${proposal.id}/decision`, {
          action: 'reject',
        })
      ).statusCode,
    ).toBe(200);
  });
  it('bounds retained proposal families without starting more inference or creating overflow', async () => {
    const proposal = await proposed();
    const row = (
      await f.db.orm.select().from(skillProposals).where(eq(skillProposals.id, proposal.id))
    )[0]!;
    await f.db.orm.insert(skillProposals).values(
      Array.from({ length: 199 }, (_value, index) => ({
        ...row,
        id: workKey('spp'),
        familyKey: valueHash(index),
      })),
    );
    const last = await completed();
    expect(await detect(last.id)).toBeNull();
    expect(
      await f.db.orm.select().from(skillProposals).where(eq(skillProposals.projectId, projectId)),
    ).toHaveLength(200);
    expect(proposalPattern(goal(), plan())).not.toBeNull();
  });
});
