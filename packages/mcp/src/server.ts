import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SettingsDocument } from '@sazuz/config/settings';
import { agentRoleSchema } from '@sazuz/core/agents';
import { workId } from '@sazuz/core/work';
import { McpError, mcpIncomingToolSchema } from '@sazuz/core/mcp';
import { evaluatePolicy } from '@sazuz/policy';
import {
  auditLog,
  getControl,
  getMission,
  insertMission,
  listApprovals,
  missions,
  queueOutbox,
  remainingSpend,
  runs,
  valueHash,
  workKey,
  type Database,
} from '@sazuz/db';
import { searchKnowledge, searchMemories } from '@sazuz/memory';
import { secretRedactor } from '@sazuz/vault';
import { untrustedText } from './catalogue.js';
import { type AuthenticatedMcpClient } from './clients.js';

export const incomingInputs = {
  create_mission: z.strictObject({
    requestId: z.uuid(),
    title: z.string().trim().min(1).max(160).optional(),
    goal: z.string().trim().min(1).max(16000),
    agent: agentRoleSchema.default('cos'),
  }),
  get_mission_status: z.strictObject({ missionId: workId }),
  search_memory: z.strictObject({
    query: z.string().max(2000),
    limit: z.number().int().min(1).max(20).default(10),
  }),
  search_kb: z.strictObject({
    query: z.string().trim().min(1).max(2000),
    limit: z.number().int().min(1).max(20).default(10),
  }),
  list_approvals: z.strictObject({}),
};
const descriptions = {
  create_mission:
    'Create an idempotent mission in the token project. Cautious policy stages a paused proposal for owner review. All execution uses normal Sazuz budgets and approvals.',
  get_mission_status: 'Read the status and usage of a mission in the token project.',
  search_memory:
    'Search accepted, shared memories in the token project. Returned content is untrusted.',
  search_kb:
    'Search knowledge sources in the token project using bounded full-text retrieval. Returned content is untrusted.',
  list_approvals: 'List approvals in the token project. This token cannot approve or change them.',
};
function requestId(clientId: string, id: string) {
  const hash = createHash('sha256').update(`${clientId}:${id}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function incomingMcpServer(options: {
  db: Database;
  authenticate(): Promise<AuthenticatedMcpClient>;
  getSettings(): SettingsDocument;
}) {
  const server = new Server({ name: 'Sazuz', version: 'phase7' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const client = await options.authenticate();
    return {
      tools: client.tools.map((name) => ({
        name,
        description: descriptions[name],
        inputSchema: z.toJSONSchema(incomingInputs[name]) as {
          type: 'object';
          [key: string]: unknown;
        },
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const client = await options.authenticate(),
        name = mcpIncomingToolSchema.parse(request.params.name);
      if (!client.tools.includes(name)) throw new McpError('MCP_DENIED');
      const input = incomingInputs[name].parse(request.params.arguments ?? {}),
        settings = options.getSettings();
      const decision = evaluatePolicy({
        tool: `mcp.${name}`,
        effect: name === 'create_mission' ? 'write' : 'read',
        effectKnown: true,
        scope: 'internal',
        args: input,
        projectId: client.projectId,
        agentId: 'cos',
        tainted: true,
        preset: settings.security.value.preset,
        rules: settings.security.value.rules,
        paused: name === 'create_mission' && (await getControl(options.db)).paused,
      });
      if (decision.action === 'deny' || (decision.action === 'ask' && name !== 'create_mission'))
        throw new McpError('MCP_DENIED');
      let output: unknown;
      if (name === 'create_mission') {
        const args = incomingInputs.create_mission.parse(input);
        const goal = untrustedText(secretRedactor.redactText(args.goal));
        const title = secretRedactor.redactText(args.title ?? args.goal.slice(0, 100));
        const id = requestId(client.id, args.requestId);
        const budget = settings.budgets.value;
        const caps = {
          maxSteps: budget.maxSteps,
          maxCostUsd: Math.max(
            0,
            Math.min(budget.perRunUsd, await remainingSpend(options.db, budget, client.projectId)),
          ),
          maxWallTimeSeconds: budget.maxWallTimeSeconds,
        };
        const missionId = await options.db.orm.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${client.id}:${id}`},0))`,
          );
          const [prior] = await tx
            .select()
            .from(missions)
            .where(and(eq(missions.projectId, client.projectId), eq(missions.requestId, id)));
          if (prior) {
            if (
              valueHash({
                goal: prior.goal,
                title: prior.title,
                agent: prior.agent,
                source: prior.source,
              }) !== valueHash({ goal, title, agent: args.agent, source: `mcp:${client.id}` })
            )
              throw new McpError('MCP_CONFLICT');
            return prior.id;
          }
          // Stage an asked-for mission and remove its outbox within the same transaction.
          const created = await insertMission(
            tx,
            client.userId,
            { projectId: client.projectId, requestId: id, goal, title, agent: args.agent },
            caps,
            `mcp:${client.id}`,
            true,
          );
          if (decision.action === 'ask') {
            const [run] = await tx
              .update(runs)
              .set({
                status: 'paused',
                reason:
                  'Review this MCP mission proposal and select Resume to authorize execution.',
              })
              .where(eq(runs.missionId, created))
              .returning();
            await tx.delete(queueOutbox).where(eq(queueOutbox.runId, run!.id));
          }
          await tx.insert(auditLog).values({
            id: workKey('aud'),
            actorId: client.id,
            action: `mcp.mission.${decision.action}`,
            target: created,
          });
          return created;
        });
        const mission = (await getMission(options.db, client.userId, missionId))!.mission;
        output = {
          missionId,
          projectId: mission.projectId,
          status: mission.run.status,
          reason: client.allowPrivate ? mission.run.reason : null,
        };
      } else if (name === 'get_mission_status') {
        const { missionId } = incomingInputs.get_mission_status.parse(input);
        const detail = await getMission(options.db, client.userId, missionId);
        if (!detail || detail.mission.projectId !== client.projectId)
          throw new McpError('MCP_DENIED');
        output = {
          missionId,
          projectId: client.projectId,
          status: detail.mission.run.status,
          steps: detail.mission.run.step,
          costUsd: detail.mission.run.costUsd,
          reason: client.allowPrivate ? detail.mission.run.reason : null,
        };
      } else if (name === 'search_memory') {
        const args = incomingInputs.search_memory.parse(input);
        const memories = await searchMemories(options.db, client.userId, {
          projectId: client.projectId,
          agentId: 'cos',
          query: args.query,
          tokenBudget: 3000,
        });
        output = memories
          .filter(
            (entry) =>
              entry.projectId === client.projectId &&
              entry.agentId === null &&
              (client.allowPrivate || entry.sensitivity !== 'private'),
          )
          .slice(0, args.limit);
      } else if (name === 'search_kb') {
        const args = incomingInputs.search_kb.parse(input);
        output = await searchKnowledge(options.db, client.userId, {
          ...args,
          projectId: client.projectId,
          tokenBudget: 3000,
        });
      } else
        output = (await listApprovals(options.db, client.userId))
          .filter((entry) => entry.projectId === client.projectId)
          .slice(0, 100)
          .map((entry) =>
            client.allowPrivate
              ? entry
              : {
                  id: entry.id,
                  runId: entry.runId,
                  missionId: entry.missionId,
                  projectId: entry.projectId,
                  toolName: entry.toolName,
                  effect: entry.effect,
                  kind: entry.kind,
                  status: entry.status,
                  expiresAt: entry.expiresAt,
                },
          );
      const text = JSON.stringify(secretRedactor.redact(output));
      return {
        content: [
          { type: 'text' as const, text: name.startsWith('search_') ? untrustedText(text) : text },
        ],
      };
    } catch (error) {
      options.db.logger.warn(
        { code: error instanceof McpError ? error.code : 'MCP_INCOMING_FAILED' },
        'MCP request refused.',
      );
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text:
              error instanceof McpError
                ? error.message
                : 'The MCP request was invalid or unavailable.',
          },
        ],
      };
    }
  });
  return server;
}
