import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { z } from 'zod';

export const workerHeartbeats = pgTable(
  'worker_heartbeats',
  {
    id: text('id').primaryKey(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('worker_heartbeats_last_seen_idx').on(table.lastSeenAt),
    check('worker_heartbeats_id_format', sql`${table.id} ~ '^wrk_[0-9A-HJKMNP-TV-Z]{26}$'`),
  ],
);

const time = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  createdAt: time('created_at'),
  updatedAt: time('updated_at'),
});
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (table) => [index('sessions_user_idx').on(table.userId)],
);
export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (table) => [
    uniqueIndex('accounts_provider_account_idx').on(table.providerId, table.accountId),
    index('accounts_user_idx').on(table.userId),
  ],
);
export const verifications = pgTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
);
export const twoFactors = pgTable('two_factors', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  verified: boolean('verified').notNull().default(false),
  failedVerificationCount: integer('failed_verification_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
});
export const authRateLimits = pgTable('auth_rate_limits', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});
export const installations = pgTable(
  'installation',
  {
    id: text('id').primaryKey().default('singleton'),
    workspaceId: text('workspace_id').notNull().unique(),
    tokenHash: text('token_hash'),
    adminId: text('admin_id').references(() => users.id),
    currentStep: integer('current_step').notNull().default(0),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: time('created_at'),
  },
  (table) => [
    check('installation_singleton', sql`${table.id} = 'singleton'`),
    check('installation_step', sql`${table.currentStep} BETWEEN 0 AND 12`),
  ],
);
export const setupSessions = pgTable('setup_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: time('created_at'),
});
export const securityRateLimits = pgTable('security_rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
export const settings = pgTable(
  'settings',
  {
    namespace: text('namespace').primaryKey(),
    key: text('key').notNull().default('document'),
    value: jsonb('value').notNull(),
    version: integer('version').notNull().default(1),
    updatedAt: time('updated_at'),
  },
  (table) => [
    check('settings_document_key', sql`${table.key} = 'document'`),
    check('settings_positive_version', sql`${table.version} > 0`),
  ],
);
export const settingsHistory = pgTable(
  'settings_history',
  {
    namespace: text('namespace').notNull(),
    version: integer('version').notNull(),
    value: jsonb('value').notNull(),
    actorId: text('actor_id').notNull(),
    changedAt: time('changed_at'),
  },
  (table) => [primaryKey({ columns: [table.namespace, table.version] })],
);
export const auditLog = pgTable('audit_log', {
  id: text('id').primaryKey(),
  actorId: text('actor_id').notNull(),
  action: text('action').notNull(),
  target: text('target').notNull(),
  createdAt: time('created_at'),
  sequence: bigint('sequence', { mode: 'number' }).notNull().default(0),
  canonical: text('canonical').notNull().default(''),
  previousHash: text('previous_hash').notNull().default(''),
  hash: text('hash').notNull().default(''),
});
export const auditChainState = pgTable('audit_chain_state', {
  id: text('id').primaryKey().default('singleton'),
  sequence: bigint('sequence', { mode: 'number' }).notNull().default(0),
  hash: text('hash').notNull().default('0'.repeat(64)),
});
export const passkeys = pgTable('passkeys', {
  id: text('id').primaryKey(),
  name: text('name'),
  publicKey: text('public_key').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  credentialID: text('credential_id').notNull().unique(),
  counter: bigint('counter', { mode: 'number' }).notNull(),
  deviceType: text('device_type').notNull(),
  backedUp: boolean('backed_up').notNull(),
  transports: text('transports'),
  createdAt: time('created_at'),
  aaguid: text('aaguid'),
});
export const workspaceMemberships = pgTable(
  'workspace_memberships',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => installations.workspaceId, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('owner'),
    createdAt: time('created_at'),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    uniqueIndex('workspace_memberships_workspace_idx').on(table.workspaceId),
  ],
);
export const operations = pgTable(
  'operations',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    requestKey: text('request_key').notNull(),
    inputHash: text('input_hash').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    stage: text('stage').notNull().default('reserved'),
    code: text('code'),
    metadata: jsonb('metadata').notNull().default({}),
    bytes: integer('bytes').notNull().default(0),
    receivedBytes: integer('received_bytes').notNull().default(0),
    sha256: text('sha256'),
    createdAt: time('created_at'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('operations_request_idx').on(table.kind, table.requestKey)],
);
export const backups = pgTable('backups', {
  id: text('id').primaryKey(),
  operationId: text('operation_id')
    .notNull()
    .unique()
    .references(() => operations.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  status: text('status').notNull(),
  bytes: integer('bytes').notNull(),
  sha256: text('sha256').notNull(),
  createdAt: time('created_at'),
});
export const operationGate = pgTable('operation_gate', {
  id: text('id').primaryKey().default('singleton'),
  operationId: text('operation_id'),
  updatedAt: time('updated_at'),
});
export const vaultMeta = pgTable(
  'vault_meta',
  {
    id: text('id').primaryKey().default('singleton'),
    revision: integer('revision').notNull(),
    value: jsonb('value').notNull(),
  },
  (table) => [check('vault_meta_singleton', sql`${table.id} = 'singleton'`)],
);
export const secrets = pgTable(
  'secrets',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    purpose: text('purpose').notNull(),
    ciphertext: text('ciphertext').notNull(),
    nonce: text('nonce').notNull(),
    envelopeVersion: integer('envelope_version').notNull(),
    createdBy: text('created_by').notNull(),
    maskedValue: text('masked_value').notNull(),
    revision: integer('revision').notNull(),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (table) => [
    index('secrets_workspace_idx').on(table.workspaceId),
    check(
      'secrets_purpose',
      sql`${table.purpose} IN ('user', 'authentication', 'browser-profiles', 'web-push')`,
    ),
  ],
);
export const workerSettings = pgTable('worker_settings', {
  workerId: text('worker_id')
    .primaryKey()
    .references(() => workerHeartbeats.id, { onDelete: 'cascade' }),
  versions: jsonb('versions').notNull(),
  appliedAt: time('applied_at'),
});

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  brief: text('brief').notNull().default(''),
  privacy: text('privacy').notNull().default('standard'),
  budgetUsd: doublePrecision('budget_usd').notNull(),
  reviewMode: text('review_mode').notNull().default('off'),
  reviewVersion: integer('review_version').notNull().default(1),
  createdAt: time('created_at'),
});
export const threads = pgTable('threads', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  createdAt: time('created_at'),
});
export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    trust: text('trust').notNull().default('trusted'),
    requestId: text('request_id'),
    providerId: text('provider_id'),
    modelId: text('model_id'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    usageEstimated: boolean('usage_estimated').notNull().default(false),
    toolCalls: jsonb('tool_calls').notNull().default([]),
    toolCallId: text('tool_call_id'),
    toolName: text('tool_name'),
    createdAt: time('created_at'),
  },
  (table) => [
    uniqueIndex('messages_request_idx').on(table.threadId, table.requestId),
    index('messages_thread_idx').on(table.threadId, table.createdAt),
  ],
);
export const modelCatalog = pgTable(
  'models',
  {
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    value: jsonb('value').notNull(),
    discoveredAt: time('discovered_at'),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.modelId] })],
);
export const costLedger = pgTable(
  'cost_ledger',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    agentId: text('agent_id').notNull(),
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cachedInputTokens: integer('cached_input_tokens').notNull(),
    costUsd: doublePrecision('cost_usd').notNull(),
    estimated: boolean('estimated').notNull(),
    latencyMs: doublePrecision('latency_ms').notNull(),
    status: text('status').notNull(),
    createdAt: time('created_at'),
  },
  (table) => [index('cost_ledger_time_idx').on(table.createdAt)],
);

export const costAlerts = pgTable('cost_alerts', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  eventKey: text('event_key').notNull().unique(),
  period: text('period').notNull(),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  capUsd: doublePrecision('cap_usd').notNull(),
  threshold: integer('threshold').notNull(),
  spentUsd: doublePrecision('spent_usd').notNull(),
  createdAt: time('created_at'),
});
export const telemetryExports = pgTable(
  'telemetry_exports',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ledgerId: text('ledger_id')
      .notNull()
      .unique()
      .references(() => costLedger.id, { onDelete: 'cascade' }),
    settingsVersion: integer('settings_version').notNull(),
    status: text('status').notNull(),
    code: text('code'),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (table) => [index('telemetry_exports_owner_time_idx').on(table.userId, table.createdAt)],
);

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id').notNull(),
    requestHash: text('request_hash').notNull(),
    mode: text('mode').notNull(),
    judge: boolean('judge').notNull(),
    suites: jsonb('suites').notNull(),
    presets: jsonb('presets').notNull(),
    limits: jsonb('limits').notNull(),
    privateOnly: boolean('private_only').notNull(),
    status: text('status').notNull().default('queued'),
    totalCases: integer('total_cases').notNull(),
    completedCases: integer('completed_cases').notNull().default(0),
    passedCases: integer('passed_cases').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    judgeCostUsd: doublePrecision('judge_cost_usd').notNull().default(0),
    createdAt: time('created_at'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('eval_runs_request_idx').on(table.userId, table.requestId),
    index('eval_runs_owner_time_idx').on(table.userId, table.createdAt),
  ],
);
export const evalResults = pgTable(
  'eval_results',
  {
    id: text('id').primaryKey(),
    evalRunId: text('eval_run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    suite: text('suite').notNull(),
    preset: text('preset').notNull(),
    caseId: text('case_id').notNull(),
    status: text('status').notNull().default('pending'),
    checkpoint: jsonb('checkpoint'),
    journal: jsonb('journal'),
    result: jsonb('result'),
    updatedAt: time('updated_at'),
  },
  (table) => [
    uniqueIndex('eval_results_ordinal_idx').on(table.evalRunId, table.ordinal),
    uniqueIndex('eval_results_case_idx').on(
      table.evalRunId,
      table.suite,
      table.preset,
      table.caseId,
    ),
  ],
);

export const missions = pgTable(
  'missions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    goal: text('goal').notNull(),
    agent: text('agent').notNull(),
    requestId: text('request_id').notNull(),
    source: text('source').notNull().default('web'),
    recipePolicy: text('recipe_policy'),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (table) => [uniqueIndex('missions_project_request_idx').on(table.projectId, table.requestId)],
);
export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    parentRunId: text('parent_run_id').references((): AnyPgColumn => runs.id, {
      onDelete: 'cascade',
    }),
    assignment: jsonb('assignment'),
    workflowNode: jsonb('workflow_node'),
    status: text('status').notNull().default('queued'),
    agentId: text('agent_id').notNull().default('cos'),
    checkpoint: jsonb('checkpoint'),
    limits: jsonb('limits').notNull(),
    step: integer('step').notNull().default(0),
    reviewSteps: integer('review_steps').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    tainted: boolean('tainted').notNull().default(false),
    reason: text('reason'),
    version: integer('version').notNull().default(1),
    workerId: text('worker_id'),
    claimKey: text('claim_key'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (table) => [
    index('runs_status_idx').on(table.status),
    uniqueIndex('runs_root_mission_idx')
      .on(table.missionId)
      .where(sql`${table.parentRunId} IS NULL`),
    index('runs_parent_idx').on(table.parentRunId),
  ],
);
export const runSteps = pgTable(
  'run_steps',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    eventKey: text('event_key').notNull(),
    ordinal: integer('ordinal').notNull(),
    agentId: text('agent_id').notNull(),
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    prompt: text('prompt'),
    replayState: jsonb('replay_state'),
    toolName: text('tool_name'),
    toolArgs: jsonb('tool_args'),
    toolResult: jsonb('tool_result'),
    providerId: text('provider_id'),
    modelId: text('model_id'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    createdAt: time('created_at'),
  },
  (table) => [
    uniqueIndex('run_steps_event_idx').on(table.runId, table.eventKey),
    index('run_steps_order_idx').on(table.runId, table.ordinal),
  ],
);
export const runReplays = pgTable(
  'run_replays',
  {
    runId: text('run_id')
      .primaryKey()
      .references(() => runs.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceRunId: text('source_run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sourceStepId: text('source_step_id')
      .notNull()
      .references(() => runSteps.id, { onDelete: 'cascade' }),
    sourceOrdinal: integer('source_ordinal').notNull(),
    requestId: text('request_id').notNull(),
    requestHash: text('request_hash').notNull(),
    model: jsonb('model'),
    skill: jsonb('skill'),
    fixtures: jsonb('fixtures').notNull(),
    privateOnly: boolean('private_only').notNull(),
    reconstructed: boolean('reconstructed').notNull(),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('run_replay_request_idx').on(table.userId, table.requestId)],
);

export const toolCalls = pgTable('tool_calls', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  toolName: text('tool_name').notNull(),
  args: jsonb('args').notNull(),
  argsHash: text('args_hash').notNull(),
  effect: text('effect').notNull(),
  status: text('status').notNull(),
  result: jsonb('result'),
  attempt: integer('attempt').notNull().default(1),
  createdAt: time('created_at'),
  updatedAt: time('updated_at'),
});
export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    callKey: text('call_key').notNull(),
    agentId: text('agent_id').notNull(),
    toolName: text('tool_name').notNull(),
    args: jsonb('args').notNull(),
    argsHash: text('args_hash').notNull(),
    effect: text('effect').notNull(),
    reason: text('reason').notNull(),
    risk: text('risk').notNull(),
    ruleId: text('rule_id').notNull(),
    tainted: boolean('tainted').notNull(),
    kind: text('kind').notNull().default('policy'),
    status: text('status').notNull().default('pending'),
    version: integer('version').notNull().default(1),
    note: text('note'),
    decision: text('decision'),
    decidedBy: text('decided_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (table) => [
    uniqueIndex('approvals_call_kind_idx').on(table.runId, table.callKey, table.kind),
    index('approvals_status_idx').on(table.status),
  ],
);
export const agentMessages = pgTable(
  'agent_messages',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    eventKey: text('event_key').notNull(),
    from: text('from_agent').notNull(),
    to: text('to_agent').notNull(),
    type: text('type').notNull(),
    taskId: text('task_id'),
    payload: jsonb('payload'),
    content: text('content').notNull(),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('agent_messages_event_idx').on(table.missionId, table.eventKey)],
);
export const auditReviews = pgTable(
  'audit_reviews',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sourceKey: text('source_key').notNull(),
    kind: text('kind').notNull(),
    subjectHash: text('subject_hash').notNull(),
    bindingHash: text('binding_hash').notNull(),
    request: jsonb('request').notNull(),
    evidence: jsonb('evidence').notNull(),
    status: text('status').notNull().default('pending'),
    verdict: jsonb('verdict'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: time('created_at'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('audit_reviews_binding_idx').on(
      table.runId,
      table.sourceKey,
      table.bindingHash,
      table.expiresAt,
    ),
    check('audit_reviews_attempts', sql`${table.attempts} BETWEEN 0 AND 2`),
    check('audit_reviews_status', sql`${table.status} IN ('pending','accepted','rejected')`),
  ],
);
export const missionGraphs = pgTable('mission_graphs', {
  missionId: text('mission_id')
    .primaryKey()
    .references(() => missions.id, { onDelete: 'cascade' }),
  rootRunId: text('root_run_id')
    .notNull()
    .unique()
    .references(() => runs.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull().default(1),
  definition: jsonb('definition').notNull(),
  createdAt: time('created_at'),
});
export const graphRevisions = pgTable(
  'graph_revisions',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    definition: jsonb('definition').notNull(),
    reason: text('reason').notNull(),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('graph_revisions_version_idx').on(table.missionId, table.revision)],
);
export const missionTasks = pgTable(
  'mission_tasks',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    taskKey: text('task_key').notNull(),
    definition: jsonb('definition').notNull(),
    status: text('status').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    feedback: text('feedback'),
    result: jsonb('result'),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (table) => [uniqueIndex('mission_tasks_key_idx').on(table.missionId, table.taskKey)],
);
export const taskAttempts = pgTable(
  'task_attempts',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => missionTasks.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .unique()
      .references(() => runs.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('task_attempts_number_idx').on(table.taskId, table.attempt)],
);
export const blackboardEntries = pgTable(
  'blackboard_entries',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    agentId: text('agent_id').notNull(),
    eventKey: text('event_key').notNull(),
    text: text('text').notNull(),
    artifacts: jsonb('artifacts').notNull().default([]),
    tainted: boolean('tainted').notNull().default(true),
    privateOnly: boolean('private_only').notNull().default(false),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('blackboard_event_idx').on(table.missionId, table.eventKey)],
);
export const providerBuckets = pgTable('provider_buckets', {
  providerId: text('provider_id').primaryKey(),
  tokens: doublePrecision('tokens').notNull(),
  updatedAt: time('updated_at'),
});
export const queueOutbox = pgTable('queue_outbox', {
  runId: text('run_id')
    .primaryKey()
    .references(() => runs.id, { onDelete: 'cascade' }),
  generation: integer('generation').notNull().default(1),
  createdAt: time('created_at'),
});
export const executionControl = pgTable(
  'execution_control',
  {
    id: text('id').primaryKey().default('singleton'),
    paused: boolean('paused').notNull().default(false),
    version: integer('version').notNull().default(1),
    updatedAt: time('updated_at'),
  },
  (table) => [check('execution_control_singleton', sql`${table.id}='singleton'`)],
);
export const executionNonces = pgTable('execution_nonces', {
  nonce: text('nonce').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
export const triggers = pgTable(
  'triggers',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    goal: text('goal').notNull(),
    agent: text('agent').notNull(),
    config: jsonb('config').notNull(),
    workflowId: text('workflow_id').references((): AnyPgColumn => workflows.id, {
      onDelete: 'cascade',
    }),
    workflowRevision: integer('workflow_revision'),
    recipePolicy: text('recipe_policy'),
    enabled: boolean('enabled').notNull().default(true),
    version: integer('version').notNull().default(1),
    cursor: jsonb('cursor'),
    failures: integer('failures').notNull().default(0),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: time('created_at'),
  },
  (table) => [index('triggers_due_idx').on(table.enabled, table.nextRunAt)],
);
export const triggerEvents = pgTable(
  'trigger_events',
  {
    id: text('id').primaryKey(),
    triggerId: text('trigger_id')
      .notNull()
      .references(() => triggers.id, { onDelete: 'cascade' }),
    dedupeKey: text('dedupe_key').notNull(),
    missionId: text('mission_id').references(() => missions.id, { onDelete: 'set null' }),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('trigger_events_dedupe_idx').on(table.triggerId, table.dedupeKey)],
);
export const scheduleReviews = pgTable('schedule_reviews', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  configHash: text('config_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
export const telegramPairingCodes = pgTable('telegram_pairing_codes', {
  codeHash: text('code_hash').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
export const telegramBindings = pgTable('telegram_bindings', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  senderId: text('sender_id').notNull().unique(),
  chatId: text('chat_id').notNull(),
  createdAt: time('created_at'),
});
export const channelState = pgTable('channel_state', {
  id: text('id').primaryKey(),
  offset: bigint('offset', { mode: 'number' }).notNull().default(0),
  lastPollAt: timestamp('last_poll_at', { withTimezone: true }),
  lastError: text('last_error'),
});
export const channelReceipts = pgTable('channel_receipts', {
  id: text('id').primaryKey(),
  createdAt: time('created_at'),
});
export const notifications = pgTable('notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  missionId: text('mission_id').references(() => missions.id, { onDelete: 'cascade' }),
  sourceRunId: text('source_run_id').references(() => runs.id, { onDelete: 'set null' }),
  signals: jsonb('signals').notNull().default({}),
  critical: boolean('critical').notNull().default(false),
  priorityEvidence: jsonb('priority_evidence'),
  feedback: text('feedback'),
  classificationStatus: text('classification_status').notNull().default('pending'),
  classificationClaim: uuid('classification_claim'),
  classificationWorker: text('classification_worker'),
  classificationAt: timestamp('classification_at', { withTimezone: true }),
  privateOnly: boolean('private_only').notNull().default(false),
  eventKey: text('event_key').notNull().unique(),
  level: text('level').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull().default('pending'),
  dueAt: timestamp('due_at', { withTimezone: true }),
  createdAt: time('created_at'),
});
export const digests = pgTable('digests', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  itemCount: integer('item_count').notNull(),
  notificationIds: jsonb('notification_ids').notNull().default([]),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  deliveryStatus: text('delivery_status').notNull().default('web'),
  createdAt: time('created_at'),
});
export const deliveryIntents = pgTable('delivery_intents', {
  id: text('id').primaryKey(),
  status: text('status').notNull(),
  channel: text('channel').notNull(),
  target: text('target').notNull(),
  result: jsonb('result'),
  createdAt: time('created_at'),
  updatedAt: time('updated_at'),
});
export const notificationInterruptions = pgTable(
  'notification_interruptions',
  {
    deliveryId: text('delivery_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    slot: integer('slot').notNull(),
    createdAt: time('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.deliveryId, t.day] }),
    uniqueIndex('notification_interruption_slot_idx').on(t.userId, t.day, t.slot),
  ],
);
export const notificationFeedback = pgTable(
  'notification_feedback',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id').notNull(),
    notificationId: text('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    bias: integer('bias').notNull(),
    settingsVersion: integer('settings_version').notNull(),
    createdAt: time('created_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.requestId] })],
);
export const oauthStates = pgTable('oauth_states', {
  stateHash: text('state_hash').primaryKey(),
  provider: text('provider').notNull().default('google'),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  verifierRef: text('verifier_ref').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
export const artifacts = pgTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    eventKey: text('event_key').notNull(),
    content: text('content').notNull(),
    untrusted: boolean('untrusted').notNull(),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('artifacts_event_idx').on(table.runId, table.eventKey)],
);

export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    agentId: text('agent_id'),
    scope: text('scope').notNull(),
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    importance: doublePrecision('importance').notNull().default(0.5),
    status: text('status').notNull().default('proposed'),
    sensitivity: text('sensitivity').notNull().default('private'),
    sourceRunId: text('source_run_id').references(() => runs.id, { onDelete: 'set null' }),
    sourceMessageId: text('source_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    sourceQuote: text('source_quote'),
    version: integer('version').notNull().default(1),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (table) => [
    index('memories_scope_idx').on(table.userId, table.projectId, table.agentId, table.status),
    check(
      'memories_scope_check',
      sql`(${table.scope}='global' AND ${table.projectId} IS NULL AND ${table.agentId} IS NULL) OR (${table.scope}='project' AND ${table.projectId} IS NOT NULL AND ${table.agentId} IS NULL) OR (${table.scope}='agent' AND ${table.projectId} IS NOT NULL AND ${table.agentId} IS NOT NULL)`,
    ),
    check('memories_status_check', sql`${table.status} IN ('proposed','accepted','rejected')`),
    check('memories_importance_check', sql`${table.importance} BETWEEN 0 AND 1`),
  ],
);
// Content-free receipts survive deletion so an old intent cannot recreate a forgotten memory.
export const memoryReceipts = pgTable('memory_receipts', {
  key: text('key').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  memoryId: text('memory_id').notNull(),
  createdAt: time('created_at'),
});
export const knowledgeJobs = pgTable(
  'knowledge_jobs',
  {
    id: text('id').primaryKey(),
    eventKey: text('event_key').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    checkpoint: jsonb('checkpoint'),
    status: text('status').notNull().default('queued'),
    workerId: text('worker_id'),
    claimKey: text('claim_key'),
    providerId: text('provider_id'),
    modelId: text('model_id'),
    sourceId: text('source_id').references(() => kbSources.id, { onDelete: 'cascade' }),
    step: integer('step').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    maxCostUsd: doublePrecision('max_cost_usd').notNull(),
    errorCode: text('error_code'),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (table) => [index('knowledge_jobs_status_idx').on(table.status, table.createdAt)],
);

export const kbSources = pgTable(
  'kb_sources',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    contentHash: text('content_hash').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    url: text('url'),
    status: text('status').notNull().default('queued'),
    errorCode: text('error_code'),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('kb_sources_request_idx').on(table.userId, table.requestId)],
);
export const kbDocuments = pgTable(
  'kb_documents',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => kbSources.id, { onDelete: 'cascade' }),
    locator: text('locator').notNull(),
    text: text('text').notNull(),
    ordinal: integer('ordinal').notNull(),
  },
  (table) => [uniqueIndex('kb_documents_source_idx').on(table.sourceId, table.ordinal)],
);
export const kbChunks = pgTable(
  'kb_chunks',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => kbSources.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => kbDocuments.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    locator: text('locator').notNull(),
    ordinal: integer('ordinal').notNull(),
    createdAt: time('created_at'),
  },
  (table) => [
    uniqueIndex('kb_chunks_source_idx').on(table.sourceId, table.ordinal),
    index('kb_chunks_fts_idx').using('gin', sql`to_tsvector('simple', ${table.text})`),
  ],
);
export const embeddingGenerations = pgTable(
  'embedding_generations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    providerUrl: text('provider_url').notNull(),
    status: text('status').notNull().default('building'),
    dimensions: integer('dimensions'),
    createdAt: time('created_at'),
  },
  (table) => [
    uniqueIndex('embedding_generation_fingerprint_idx').on(table.projectId, table.fingerprint),
    uniqueIndex('embedding_generation_active_idx')
      .on(table.projectId)
      .where(sql`${table.status}='active'`),
  ],
);
const embeddingVector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => JSON.stringify(z.array(z.number().finite()).min(1).max(4096).parse(value)),
  fromDriver: (value) => z.array(z.number().finite()).parse(JSON.parse(value)),
});
export const memoryEmbeddings = pgTable(
  'memory_embeddings',
  {
    memoryId: text('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    generationId: text('generation_id')
      .notNull()
      .references(() => embeddingGenerations.id, { onDelete: 'cascade' }),
    memoryVersion: integer('memory_version').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    vector: embeddingVector('vector').notNull(),
  },
  (table) => [primaryKey({ columns: [table.generationId, table.memoryId] })],
);
export const kbEmbeddings = pgTable(
  'kb_embeddings',
  {
    chunkId: text('chunk_id')
      .notNull()
      .references(() => kbChunks.id, { onDelete: 'cascade' }),
    generationId: text('generation_id')
      .notNull()
      .references(() => embeddingGenerations.id, { onDelete: 'cascade' }),
    embeddingModel: text('embedding_model').notNull(),
    vector: embeddingVector('vector').notNull(),
  },
  (table) => [primaryKey({ columns: [table.generationId, table.chunkId] })],
);

export const skills = pgTable(
  'skills',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    source: text('source').notNull(),
    revision: integer('revision').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    privateOnly: boolean('private_only').notNull().default(false),
    updatedAt: time('updated_at'),
  },
  (table) => [
    uniqueIndex('skills_owner_name_idx').on(table.userId, table.name),
    uniqueIndex('skills_builtin_name_idx')
      .on(table.name)
      .where(sql`${table.userId} IS NULL`),
  ],
);
export const skillVersions = pgTable(
  'skill_versions',
  {
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    manifest: jsonb('manifest').notNull(),
    markdown: text('markdown').notNull(),
    sha256: text('sha256').notNull(),
    privateOnly: boolean('private_only').notNull().default(false),
    createdAt: time('created_at'),
  },
  (table) => [primaryKey({ columns: [table.skillId, table.revision] })],
);
export const skillSelections = pgTable('skill_selections', {
  key: text('key').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  skillId: text('skill_id')
    .notNull()
    .references(() => skills.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  sha256: text('sha256').notNull(),
  createdAt: time('created_at'),
});
export const styleProfiles = pgTable(
  'style_profiles',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    inputHash: text('input_hash').notNull(),
    status: text('status').notNull().default('generating'),
    privateOnly: boolean('private_only').notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    sources: jsonb('sources').notNull().default([]),
    markdown: text('markdown'),
    sampleDraft: text('sample_draft'),
    errorCode: text('error_code'),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    skillId: text('skill_id').references(() => skills.id, { onDelete: 'set null' }),
    revision: integer('revision'),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('style_profile_request_idx').on(table.userId, table.requestId)],
);

export const styleComparisons = pgTable(
  'style_comparisons',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id').notNull(),
    inputHash: text('input_hash').notNull(),
    task: text('task').notNull(),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    sha256: text('sha256').notNull(),
    privateOnly: boolean('private_only').notNull(),
    status: text('status').notNull().default('generating'),
    styledLabel: text('styled_label').notNull(),
    genericDraft: text('generic_draft'),
    styledDraft: text('styled_draft'),
    vote: text('vote'),
    errorCode: text('error_code'),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    createdAt: time('created_at'),
    votedAt: timestamp('voted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('style_comparison_request_idx').on(table.userId, table.requestId),
    index('style_comparison_project_idx').on(table.projectId, table.createdAt),
  ],
);

export const skillProposals = pgTable(
  'skill_proposals',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    familyKey: text('family_key').notNull(),
    planSignature: text('plan_signature').notNull(),
    fingerprint: jsonb('fingerprint').notNull(),
    sources: jsonb('sources').notNull(),
    markdown: text('markdown').notNull(),
    privateOnly: boolean('private_only').notNull(),
    status: text('status').notNull().default('proposed'),
    decisionHash: text('decision_hash'),
    skillId: text('skill_id').references(() => skills.id, { onDelete: 'set null' }),
    revision: integer('revision'),
    createdAt: time('created_at'),
  },
  (table) => [
    uniqueIndex('skill_proposal_family_idx').on(table.userId, table.projectId, table.familyKey),
    index('skill_proposal_project_idx').on(table.projectId, table.createdAt),
    index('skill_proposal_skill_idx').on(table.skillId),
  ],
);

export const browserRecordings = pgTable(
  'browser_recordings',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => browserSessions.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id').notNull(),
    inputHash: text('input_hash').notNull(),
    name: text('name').notNull(),
    site: text('site').notNull(),
    status: text('status').notNull().default('recording'),
    version: integer('version').notNull().default(1),
    events: jsonb('events').notNull().default([]),
    omitted: integer('omitted').notNull().default(0),
    privateOnly: boolean('private_only').notNull().default(true),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (table) => [
    uniqueIndex('browser_recording_request_idx').on(table.userId, table.requestId),
    uniqueIndex('browser_recording_active_idx')
      .on(table.sessionId)
      .where(sql`${table.status}='recording'`),
  ],
);
export const learningDrafts = pgTable(
  'learning_drafts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    recordingId: text('recording_id')
      .notNull()
      .references(() => browserRecordings.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id').notNull(),
    inputHash: text('input_hash').notNull(),
    status: text('status').notNull().default('generating'),
    name: text('name').notNull(),
    description: text('description'),
    program: jsonb('program'),
    markdown: text('markdown'),
    script: text('script'),
    privateOnly: boolean('private_only').notNull(),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    errorCode: text('error_code'),
    savedHash: text('saved_hash'),
    skillId: text('skill_id').references(() => skills.id, { onDelete: 'set null' }),
    revision: integer('revision'),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('learning_draft_request_idx').on(table.userId, table.requestId)],
);
export const learnedSkillVersions = pgTable(
  'learned_skill_versions',
  {
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    recordingId: text('recording_id').references(() => browserRecordings.id, {
      onDelete: 'set null',
    }),
    program: jsonb('program').notNull(),
    programHash: text('program_hash').notNull(),
    script: text('script').notNull(),
    createdAt: time('created_at'),
  },
  (table) => [primaryKey({ columns: [table.skillId, table.revision] })],
);

export const recipeInstallations = pgTable(
  'recipe_installations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    inputHash: text('input_hash').notNull(),
    preview: jsonb('preview').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    installedAt: timestamp('installed_at', { withTimezone: true }),
    missionId: text('mission_id').references(() => missions.id, { onDelete: 'set null' }),
    triggerId: text('trigger_id').references(() => triggers.id, { onDelete: 'set null' }),
    workflowId: text('workflow_id').references((): AnyPgColumn => workflows.id, {
      onDelete: 'set null',
    }),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('recipe_installation_request_idx').on(table.userId, table.requestId)],
);

export const sandboxExecutions = pgTable('sandbox_executions', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull(),
  key: text('idempotency_key').notNull().unique(),
  argsHash: text('args_hash').notNull(),
  containerName: text('container_name').notNull().unique(),
  language: text('language').notNull(),
  network: text('network').notNull(),
  status: text('status').notNull().default('creating'),
  result: jsonb('result'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: time('created_at'),
  updatedAt: time('updated_at'),
});

export const browserProfiles = pgTable('browser_profiles', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull(),
  name: text('name').notNull(),
  site: text('site').notNull(),
  secretRefs: jsonb('secret_refs').notNull().default([]),
  vaultRef: text('vault_ref'),
  version: integer('version').notNull().default(1),
  generation: integer('generation').notNull().default(1),
  retired: boolean('retired').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: time('created_at'),
  updatedAt: time('updated_at'),
});
export const browserSessions = pgTable(
  'browser_sessions',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => browserProfiles.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    profileGeneration: integer('profile_generation').notNull(),
    serviceId: text('service_id').notNull(),
    status: text('status').notNull().default('opening'),
    control: text('control').notNull().default('agent'),
    version: integer('version').notNull().default(1),
    sensitive: boolean('sensitive').notNull().default(false),
    challenge: text('challenge'),
    origin: text('origin').notNull().default(''),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (table) => [
    uniqueIndex('browser_profile_active_idx')
      .on(table.profileId)
      .where(sql`${table.status} IN ('opening','active')`),
  ],
);
export const browserActions = pgTable('browser_actions', {
  key: text('idempotency_key').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => browserSessions.id, { onDelete: 'cascade' }),
  argsHash: text('args_hash').notNull(),
  operation: text('operation').notNull(),
  status: text('status').notNull().default('started'),
  result: jsonb('result'),
  createdAt: time('created_at'),
  updatedAt: time('updated_at'),
});

export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    currentVersion: integer('current_version').notNull().default(1),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (table) => [uniqueIndex('agents_owner_role_idx').on(table.userId, table.role)],
);
export const agentVersions = pgTable(
  'agent_versions',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    definition: jsonb('definition').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('agent_versions_revision_idx').on(table.agentId, table.version)],
);
export const agentIdentities = pgTable('agent_identities', {
  agentId: text('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),
  display: text('display').notNull(),
  connectorAccounts: jsonb('connector_accounts').notNull().default([]),
  updatedAt: time('updated_at'),
});
export const runAgentVersions = pgTable(
  'run_agent_versions',
  {
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    revisionId: text('revision_id')
      .notNull()
      .references(() => agentVersions.id, { onDelete: 'cascade' }),
    connectorBindings: jsonb('connector_bindings').notNull().default({}),
  },
  (table) => [primaryKey({ columns: [table.runId, table.role] })],
);

export const mcpServers = pgTable('mcp_servers', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  currentVersion: integer('current_version').notNull().default(1),
  enabled: boolean('enabled').notNull().default(true),
  warning: text('warning'),
  createdAt: time('created_at'),
  updatedAt: time('updated_at'),
});
export const mcpServerVersions = pgTable(
  'mcp_server_versions',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    configuration: jsonb('configuration').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('mcp_server_version_idx').on(table.serverId, table.version)],
);
export const runMcpSelections = pgTable('run_mcp_selections', {
  runId: text('run_id')
    .primaryKey()
    .references(() => runs.id, { onDelete: 'cascade' }),
  revisionIds: jsonb('revision_ids').notNull().default([]),
});
export const mcpCalls = pgTable('mcp_calls', {
  key: text('idempotency_key').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  revisionId: text('revision_id')
    .notNull()
    .references(() => mcpServerVersions.id, { onDelete: 'cascade' }),
  argsHash: text('args_hash').notNull(),
  status: text('status').notNull().default('started'),
  result: jsonb('result'),
  createdAt: time('created_at'),
});
export const mcpClients = pgTable('mcp_clients', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  secretRef: text('secret_ref').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  tools: jsonb('tools').notNull(),
  allowPrivate: boolean('allow_private').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  version: integer('version').notNull().default(1),
  createdAt: time('created_at'),
});

export const bridgeDevices = pgTable('bridge_devices', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  secretRef: text('secret_ref').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  version: integer('version').notNull().default(1),
  enabled: boolean('enabled').notNull().default(true),
  offeredPin: text('offered_pin'),
  offered: jsonb('offered'),
  connectionId: uuid('connection_id'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: time('created_at'),
});
export const bridgeDeviceVersions = pgTable(
  'bridge_device_versions',
  {
    id: text('id').primaryKey(),
    deviceId: text('device_id')
      .notNull()
      .references(() => bridgeDevices.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    grant: jsonb('grant'),
    enabled: boolean('enabled').notNull(),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('bridge_device_version_idx').on(table.deviceId, table.version)],
);
export const runBridgeSelections = pgTable('run_bridge_selections', {
  runId: text('run_id')
    .primaryKey()
    .references(() => runs.id, { onDelete: 'cascade' }),
  revisionIds: jsonb('revision_ids').notNull().default([]),
});
export const bridgeCalls = pgTable('bridge_calls', {
  key: text('idempotency_key').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  revisionId: text('revision_id')
    .notNull()
    .references(() => bridgeDeviceVersions.id, { onDelete: 'cascade' }),
  argsHash: text('args_hash').notNull(),
  status: text('status').notNull().default('started'),
  result: jsonb('result'),
  createdAt: time('created_at'),
});

export const workflows = pgTable('workflows', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(1),
  revision: integer('revision').notNull().default(1),
  activeRevision: integer('active_revision'),
  enabled: boolean('enabled').notNull().default(false),
  triggerId: text('trigger_id'),
  createdAt: time('created_at'),
  updatedAt: time('updated_at'),
});
export const workflowVersions = pgTable(
  'workflow_versions',
  {
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    definition: jsonb('definition').notNull(),
    sha256: text('sha256').notNull(),
    reviewed: boolean('reviewed').notNull().default(false),
    createdAt: time('created_at'),
  },
  (table) => [primaryKey({ columns: [table.workflowId, table.revision] })],
);
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    runId: text('run_id')
      .primaryKey()
      .references(() => runs.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    inputHash: text('input_hash').notNull(),
    input: jsonb('input').notNull(),
    output: jsonb('output'),
    parentNodeId: text('parent_node_id'),
    itemIndex: integer('item_index').notNull().default(0),
    test: boolean('test').notNull().default(false),
    modelFree: boolean('model_free').notNull(),
    inheritedAuthority: boolean('inherited_authority').notNull().default(false),
    tainted: boolean('tainted').notNull().default(true),
    privateOnly: boolean('private_only').notNull(),
    startedAt: time('started_at'),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('workflow_run_item_idx').on(table.parentNodeId, table.itemIndex)],
);
export const workflowNodeRuns = pgTable(
  'workflow_node_runs',
  {
    id: text('id').primaryKey(),
    workflowRunId: text('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.runId, { onDelete: 'cascade' }),
    nodeKey: text('node_key').notNull(),
    attempt: integer('attempt').notNull().default(1),
    runId: text('run_id')
      .unique()
      .references(() => runs.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('pending'),
    input: jsonb('input'),
    output: jsonb('output'),
    branch: text('branch'),
    reason: text('reason'),
    tainted: boolean('tainted').notNull().default(false),
    privateOnly: boolean('private_only').notNull().default(false),
    pinned: boolean('pinned').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true }),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    createdAt: time('created_at'),
  },
  (table) => [
    uniqueIndex('workflow_node_attempt_idx').on(table.workflowRunId, table.nodeKey, table.attempt),
  ],
);
export const workflowEvents = pgTable(
  'workflow_events',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.runId, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    name: text('name').notNull(),
    data: jsonb('data').notNull(),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('workflow_event_request_idx').on(table.runId, table.requestId)],
);
export const workflowDrafts = pgTable(
  'workflow_drafts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id').notNull(),
    inputHash: text('input_hash').notNull(),
    status: text('status').notNull().default('generating'),
    definition: jsonb('definition'),
    privateOnly: boolean('private_only').notNull(),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    errorCode: text('error_code'),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('workflow_draft_request_idx').on(table.userId, table.requestId)],
);
export const workflowInvocations = pgTable('workflow_invocations', {
  callKey: text('call_key').primaryKey(),
  callerRunId: text('caller_run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  runId: text('run_id')
    .notNull()
    .references(() => workflowRuns.runId, { onDelete: 'cascade' }),
  inputHash: text('input_hash').notNull(),
  createdAt: time('created_at'),
});

export const learnedReplays = pgTable(
  'learned_replays',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    requestId: uuid('request_id').notNull(),
    inputHash: text('input_hash').notNull(),
    inputs: jsonb('inputs').notNull(),
    mode: text('mode').notNull(),
    profileId: text('profile_id').references(() => browserProfiles.id, { onDelete: 'restrict' }),
    runId: text('run_id')
      .unique()
      .references(() => runs.id, { onDelete: 'cascade' }),
    evidence: jsonb('evidence').notNull().default([]),
    allowRepair: boolean('allow_repair').notNull(),
    privateOnly: boolean('private_only').notNull(),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('learned_replay_request_idx').on(table.userId, table.requestId)],
);
export const learnedRepairs = pgTable(
  'learned_repairs',
  {
    id: text('id').primaryKey(),
    replayId: text('replay_id')
      .notNull()
      .references(() => learnedReplays.id, { onDelete: 'cascade' }),
    actionIndex: integer('action_index').notNull(),
    stepId: text('step_id').notNull(),
    status: text('status').notNull().default('generating'),
    target: jsonb('target'),
    reason: text('reason'),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    acceptedRevision: integer('accepted_revision'),
    decisionHash: text('decision_hash'),
    createdAt: time('created_at'),
  },
  (table) => [uniqueIndex('learned_repair_action_idx').on(table.replayId, table.actionIndex)],
);

export const speechReceipts = pgTable(
  'speech_receipts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id').notNull(),
    kind: text('kind').notNull(),
    inputHash: text('input_hash').notNull(),
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    settingsVersion: integer('settings_version').notNull(),
    privateOnly: boolean('private_only').notNull(),
    ledgerId: text('ledger_id')
      .notNull()
      .references(() => costLedger.id, { onDelete: 'cascade' }),
    costUsd: doublePrecision('cost_usd').notNull(),
    status: text('status').notNull().default('intent'),
    transcript: text('transcript'),
    createdAt: time('created_at'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('speech_receipts_request_idx').on(table.userId, table.requestId)],
);

export const pushDevices = pgTable('push_devices', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  endpointHash: text('endpoint_hash').notNull().unique(),
  secretRef: text('secret_ref').notNull(),
  createdAt: time('created_at'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
export const pushDeliveries = pgTable(
  'push_deliveries',
  {
    id: text('id').primaryKey(),
    deviceId: text('device_id')
      .notNull()
      .references(() => pushDevices.id, { onDelete: 'cascade' }),
    eventKey: text('event_key').notNull(),
    status: text('status').notNull().default('intent'),
    createdAt: time('created_at'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('push_deliveries_event_idx').on(table.deviceId, table.eventKey)],
);
