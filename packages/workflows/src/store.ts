import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  workflows,
  workflowVersions,
  workflowRuns,
  workflowNodeRuns,
  workflowEvents,
  projects,
  runs,
  missions,
  triggers,
  settingsHistory,
  auditLog,
  workKey,
  valueHash,
  jsonValue,
  insertMission,
  enqueueRun,
  type Database,
  type Transaction,
} from '@sazuz/db';
import {
  WorkflowError,
  workflowDefinitionSchema,
  workflowSchema,
  workflowWriteSchema,
  workflowReviewSchema,
  workflowRunInputSchema,
  workflowRunSchema,
  workflowEventSchema,
  workflowSnapshotSchema,
  type WorkflowDefinition,
} from '@sazuz/core/workflows';
import type { SettingsDocument } from '@sazuz/config/settings';
import { nextCronOccurrences } from '@sazuz/triggers';
import { secretRedactor } from '@sazuz/vault';
import { needsModel, safeData, validateExpressions } from './expression.js';

type Client = Database['orm'] | Transaction;
export const snapshotKey = (id: string, revision: number) => `${id}:${revision}`;

export function checkedDefinition(raw: unknown) {
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) throw new WorkflowError('WORKFLOW_INVALID');
  if (JSON.stringify(secretRedactor.redact(parsed.data)) !== JSON.stringify(parsed.data))
    throw new WorkflowError('WORKFLOW_INVALID');
  validateExpressions(parsed.data);
  return parsed.data;
}
export async function workflowVersion(
  client: Client,
  userId: string,
  id: string,
  revision?: number,
) {
  const [row] = await client
    .select({ workflow: workflows, version: workflowVersions, project: projects })
    .from(workflows)
    .innerJoin(projects, eq(projects.id, workflows.projectId))
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.workflowId, workflows.id),
        revision === undefined
          ? eq(workflowVersions.revision, workflows.revision)
          : eq(workflowVersions.revision, revision),
      ),
    )
    .where(and(eq(workflows.id, id), eq(projects.userId, userId)));
  if (!row) throw new WorkflowError('WORKFLOW_NOT_FOUND');
  return { ...row, definition: checkedDefinition(row.version.definition) };
}
function publicWorkflow(row: Awaited<ReturnType<typeof workflowVersion>>) {
  return workflowSchema.parse({
    id: row.workflow.id,
    projectId: row.workflow.projectId,
    version: row.workflow.version,
    activeRevision: row.workflow.activeRevision,
    enabled: row.workflow.enabled,
    triggerId: row.workflow.triggerId,
    revision: row.version.revision,
    definition: row.definition,
    updatedAt: row.workflow.updatedAt.toISOString(),
  });
}
export async function getWorkflow(db: Database, userId: string, id: string, revision?: number) {
  return publicWorkflow(await workflowVersion(db.orm, userId, id, revision));
}
export async function listWorkflows(db: Database, userId: string) {
  const rows = await db.orm
    .select({ id: workflows.id })
    .from(workflows)
    .innerJoin(projects, eq(projects.id, workflows.projectId))
    .where(eq(projects.userId, userId))
    .orderBy(desc(workflows.updatedAt))
    .limit(100);
  return Promise.all(rows.map((row) => getWorkflow(db, userId, row.id)));
}
export async function workflowHistory(db: Database, userId: string, id: string) {
  await workflowVersion(db.orm, userId, id);
  return (
    await db.orm
      .select({
        revision: workflowVersions.revision,
        reviewed: workflowVersions.reviewed,
        createdAt: workflowVersions.createdAt,
      })
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, id))
      .orderBy(desc(workflowVersions.revision))
      .limit(100)
  ).map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}
async function history(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  value: unknown,
) {
  await tx
    .insert(settingsHistory)
    .values({ namespace: `workflow:${id}`, version, value: jsonValue(value), actorId: userId });
  await tx.insert(auditLog).values({
    id: workKey('aud'),
    actorId: userId,
    action: 'workflow.configured',
    target: `${id}:${version}`,
  });
  await tx.execute(sql`SELECT pg_notify('settings_changed',${`workflow:${id}`})`);
}
export async function saveWorkflowIn(
  tx: Transaction,
  userId: string,
  id: string | null,
  raw: unknown,
) {
  const input = workflowWriteSchema.parse(raw),
    definition = checkedDefinition(input.definition);
  const [project] = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.userId, userId)));
  if (!project) throw new WorkflowError('WORKFLOW_NOT_FOUND');
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workflows:${project.id}`},0))`,
  );
  let revision = 1,
    version = 1;
  if (id) {
    const [row] = await tx
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.projectId, project.id)))
      .for('update');
    if (!row) throw new WorkflowError('WORKFLOW_NOT_FOUND');
    if (row.version !== input.expectedVersion) throw new WorkflowError('WORKFLOW_CONFLICT');
    revision = row.revision + 1;
    version = row.version + 1;
    await tx
      .update(workflows)
      .set({ revision, version, updatedAt: new Date() })
      .where(eq(workflows.id, id));
  } else {
    if (input.expectedVersion !== 0) throw new WorkflowError('WORKFLOW_CONFLICT');
    const count = await tx
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.projectId, project.id))
      .limit(100);
    if (count.length >= 100) throw new WorkflowError('WORKFLOW_LIMIT');
    id = workKey('wf');
    await tx.insert(workflows).values({ id, projectId: project.id });
  }
  await tx.insert(workflowVersions).values({
    workflowId: id,
    revision,
    definition: jsonValue(definition),
    sha256: valueHash(definition),
  });
  await history(tx, userId, id, version, { revision, definition });
  return id;
}
export async function saveWorkflow(db: Database, userId: string, id: string | null, raw: unknown) {
  const key = await db.orm.transaction((tx) => saveWorkflowIn(tx, userId, id, raw));
  return getWorkflow(db, userId, key);
}

/** The full referenced graph is fixed before dispatch; later edits cannot retarget an existing run. */
export async function workflowSnapshot(
  client: Client,
  userId: string,
  id: string,
  revision: number,
  reviewing = false,
) {
  const snapshot: Record<string, WorkflowDefinition> = {};
  const root = await workflowVersion(client, userId, id, revision);
  let nodes = 0;
  const visit = async (workflowId: string, version: number, path: string[]) => {
    const key = snapshotKey(workflowId, version);
    if (path.includes(workflowId) || path.length >= 4) throw new WorkflowError('WORKFLOW_INVALID');
    if (snapshot[key]) return;
    const row = await workflowVersion(client, userId, workflowId, version);
    if (row.project.id !== root.project.id) throw new WorkflowError('WORKFLOW_NOT_FOUND');
    if (!row.version.reviewed && !(reviewing && workflowId === id && version === revision))
      throw new WorkflowError('WORKFLOW_UNREVIEWED');
    snapshot[key] = row.definition;
    nodes += row.definition.nodes.length;
    if (nodes > 128 || Object.keys(snapshot).length > 16) throw new WorkflowError('WORKFLOW_LIMIT');
    for (const node of row.definition.nodes)
      if (node.action.kind === 'workflow' || node.action.kind === 'map')
        await visit(node.action.workflowId, node.action.revision, [...path, workflowId]);
  };
  await visit(id, revision, []);
  if (JSON.stringify(snapshot).length > 256_000) throw new WorkflowError('WORKFLOW_LIMIT');
  return {
    snapshot: workflowSnapshotSchema.parse(snapshot),
    root,
    modelFree: !Object.values(snapshot).some(needsModel),
  };
}

export async function reviewWorkflowIn(
  tx: Transaction,
  userId: string,
  id: string,
  raw: unknown,
  settings: SettingsDocument,
  now = new Date(),
) {
  const input = workflowReviewSchema.parse(raw);
  const [locked] = await tx.select().from(workflows).where(eq(workflows.id, id)).for('update');
  if (!locked || locked.version !== input.expectedVersion)
    throw new WorkflowError('WORKFLOW_CONFLICT');
  const { root, modelFree } = await workflowSnapshot(tx, userId, id, input.revision, true);
  if (modelFree && root.project.reviewMode !== 'off')
    throw new WorkflowError('WORKFLOW_MODEL_FREE');
  const action = root.definition.nodes.find((node) => node.action.kind === 'trigger')!.action;
  if (action.kind !== 'trigger') throw new WorkflowError('WORKFLOW_INVALID');
  if (action.trigger.kind === 'imap') {
    const config = action.trigger;
    const account = settings.connectors.value.accounts.find((a) => a.id === config.connectorId);
    if (
      !account?.secretRef ||
      account.provider !== 'imap-smtp' ||
      !account.scopes.includes('email:read')
    )
      throw new WorkflowError('WORKFLOW_INVALID');
  }
  let triggerId = locked.triggerId;
  if (triggerId)
    await tx
      .update(triggers)
      .set({ enabled: false, version: sql`${triggers.version}+1` })
      .where(eq(triggers.id, triggerId));
  if (action.trigger.kind !== 'manual') {
    const config = action.trigger;
    const next =
      config.kind === 'cron'
        ? new Date(
            nextCronOccurrences({
              expression: config.expression,
              timezone: config.timezone,
              now,
              count: 1,
            })[0]!,
          )
        : config.kind === 'webhook'
          ? null
          : now;
    const values = {
      name: root.definition.name,
      goal: `Run the reviewed workflow ${id} revision ${input.revision}.`,
      agent: 'cos',
      config: jsonValue(config),
      workflowId: id,
      workflowRevision: input.revision,
      recipePolicy: root.definition.policy,
      enabled: input.enabled,
      nextRunAt: next,
      cursor: null,
      failures: 0,
      lastError: null,
    };
    if (triggerId) await tx.update(triggers).set(values).where(eq(triggers.id, triggerId));
    else {
      triggerId = workKey('trg');
      await tx.insert(triggers).values({ id: triggerId, projectId: root.project.id, ...values });
    }
  }
  await tx
    .update(workflowVersions)
    .set({ reviewed: true })
    .where(and(eq(workflowVersions.workflowId, id), eq(workflowVersions.revision, input.revision)));
  await tx
    .update(workflows)
    .set({
      activeRevision: input.revision,
      enabled: input.enabled,
      triggerId,
      version: locked.version + 1,
      updatedAt: now,
    })
    .where(eq(workflows.id, id));
  await history(tx, userId, id, locked.version + 1, {
    activeRevision: input.revision,
    enabled: input.enabled,
    triggerId,
  });
}
export async function reviewWorkflow(
  db: Database,
  userId: string,
  id: string,
  raw: unknown,
  settings: SettingsDocument,
) {
  await db.orm.transaction((tx) => reviewWorkflowIn(tx, userId, id, raw, settings));
  return getWorkflow(db, userId, id);
}

export async function startWorkflowIn(
  tx: Transaction,
  userId: string,
  id: string,
  raw: unknown,
  settings: SettingsDocument,
  tainted = true,
) {
  const input = workflowRunInputSchema.parse(raw);
  safeData(input.input);
  const { root, snapshot, modelFree } = await workflowSnapshot(tx, userId, id, input.revision);
  if (modelFree && root.project.reviewMode !== 'off')
    throw new WorkflowError('WORKFLOW_MODEL_FREE');
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workflow-request:${root.project.id}:${input.requestId}`},0))`,
  );
  const hash = valueHash({ id, ...input });
  const [prior] = await tx
    .select({ workflow: workflowRuns, missionId: missions.id })
    .from(missions)
    .innerJoin(runs, and(eq(runs.missionId, missions.id), sql`${runs.parentRunId} IS NULL`))
    .leftJoin(workflowRuns, eq(workflowRuns.runId, runs.id))
    .where(and(eq(missions.projectId, root.project.id), eq(missions.requestId, input.requestId)));
  if (prior) {
    if (!prior.workflow || prior.workflow.inputHash !== hash)
      throw new WorkflowError('WORKFLOW_CONFLICT');
    return { runId: prior.workflow.runId, missionId: prior.missionId };
  }
  const caps = settings.budgets.value;
  const missionId = await insertMission(
    tx,
    userId,
    {
      projectId: root.project.id,
      title: root.definition.name,
      goal: `Execute reviewed workflow ${id}, revision ${input.revision}.`,
      agent: 'cos',
      requestId: input.requestId,
    },
    {
      maxSteps: caps.maxSteps,
      maxCostUsd: caps.perRunUsd,
      maxWallTimeSeconds: caps.maxWallTimeSeconds,
    },
    'workflow',
    tainted,
    undefined,
    root.definition.policy,
  );
  const [run] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.missionId, missionId), sql`${runs.parentRunId} IS NULL`));
  await tx.insert(workflowRuns).values({
    runId: run!.id,
    workflowId: id,
    revision: input.revision,
    snapshot: jsonValue(snapshot),
    inputHash: hash,
    input: input.input,
    test: input.test,
    modelFree,
    tainted,
    privateOnly: root.project.privacy === 'private',
    startedAt: run!.createdAt,
  });
  return { runId: run!.id, missionId };
}
export async function runWorkflow(
  db: Database,
  userId: string,
  id: string,
  raw: unknown,
  settings: SettingsDocument,
) {
  const created = await db.orm.transaction((tx) => startWorkflowIn(tx, userId, id, raw, settings));
  return getWorkflowRun(db, userId, created.runId);
}
export async function getWorkflowRun(db: Database, userId: string, runId: string) {
  const [row] = await db.orm
    .select({ workflow: workflowRuns, run: runs })
    .from(workflowRuns)
    .innerJoin(runs, eq(runs.id, workflowRuns.runId))
    .innerJoin(missions, eq(missions.id, runs.missionId))
    .innerJoin(projects, eq(projects.id, missions.projectId))
    .where(and(eq(workflowRuns.runId, runId), eq(projects.userId, userId)));
  if (!row) throw new WorkflowError('WORKFLOW_NOT_FOUND');
  const nodes = await db.orm
    .select()
    .from(workflowNodeRuns)
    .where(eq(workflowNodeRuns.workflowRunId, runId))
    .orderBy(workflowNodeRuns.createdAt);
  return workflowRunSchema.parse({
    id: runId,
    workflowId: row.workflow.workflowId,
    revision: row.workflow.revision,
    missionId: row.run.missionId,
    status: row.run.status,
    input: row.workflow.input,
    output: row.workflow.output,
    test: row.workflow.test,
    modelFree: row.workflow.modelFree,
    tainted: row.workflow.tainted,
    privateOnly: row.workflow.privateOnly,
    createdAt: row.workflow.createdAt.toISOString(),
    nodes: nodes.map((node) => ({
      id: node.id,
      key: node.nodeKey,
      attempt: node.attempt,
      status: node.status,
      runId: node.runId,
      input: node.input,
      output: node.output,
      branch: node.branch,
      reason: node.reason,
      tainted: node.tainted,
      privateOnly: node.privateOnly,
      pinned: node.pinned,
    })),
  });
}
export async function listWorkflowRuns(db: Database, userId: string, id: string) {
  await workflowVersion(db.orm, userId, id);
  const rows = await db.orm
    .select({ id: workflowRuns.runId })
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, id))
    .orderBy(desc(workflowRuns.createdAt))
    .limit(30);
  return Promise.all(rows.map((row) => getWorkflowRun(db, userId, row.id)));
}
export async function signalWorkflow(db: Database, userId: string, runId: string, raw: unknown) {
  const input = workflowEventSchema.parse(raw);
  safeData(input.data);
  await getWorkflowRun(db, userId, runId);
  await db.orm.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workflow-event:${runId}:${input.requestId}`},0))`,
    );
    const [prior] = await tx
      .select()
      .from(workflowEvents)
      .where(and(eq(workflowEvents.runId, runId), eq(workflowEvents.requestId, input.requestId)));
    if (prior && (prior.name !== input.name || valueHash(prior.data) !== valueHash(input.data)))
      throw new WorkflowError('WORKFLOW_CONFLICT');
    await tx
      .insert(workflowEvents)
      .values({ id: workKey('wfe'), runId, ...input })
      .onConflictDoNothing();
    const changed = await tx
      .update(runs)
      .set({ status: 'queued', updatedAt: new Date() })
      .where(and(eq(runs.id, runId), eq(runs.status, 'waiting_tasks')))
      .returning();
    if (changed.length) await enqueueRun(tx, runId);
  });
  return getWorkflowRun(db, userId, runId);
}
export const workflowRequestId = () => randomUUID();
