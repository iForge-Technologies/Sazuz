import { z } from 'zod';
import { missionContext, type Database } from '@sazuz/db';
import { defineTool, ToolError } from '@sazuz/tools';
import { secretRedactor } from '@sazuz/vault';

export function createProjectActivityTool(db: Database) {
  return defineTool({
    name: 'project.activity',
    effect: 'read',
    scope: 'internal',
    untrusted: true,
    privateOnly: (output) => output.privateOnly,
    description:
      'Read up to 50 recent run summaries, actual model costs, and open-loop counts for this claimed run’s project. No project override is accepted.',
    input: z.strictObject({ days: z.number().int().min(1).max(90).default(7) }),
    output: z.strictObject({
      since: z.iso.datetime(),
      costUsd: z.number().nonnegative(),
      openLoops: z.number().int().nonnegative(),
      privateOnly: z.boolean(),
      runs: z
        .array(
          z.strictObject({
            id: z.string(),
            missionId: z.string(),
            title: z.string().max(160),
            agent: z.string(),
            status: z.string(),
            costUsd: z.number().nonnegative(),
            createdAt: z.iso.datetime(),
            privateOnly: z.boolean(),
          }),
        )
        .max(50),
    }),
    async run(context, args) {
      const source = await missionContext(db, context.runId);
      if (
        !source ||
        source.project.id !== context.projectId ||
        source.run.status !== 'running' ||
        source.run.claimKey !== context.claimKey
      )
        throw new ToolError('TOOL_FAILED');
      const since = new Date(Date.now() - args.days * 86400000);
      const rows = await db.pool.query<{
        id: string;
        missionId: string;
        title: string;
        agent: string;
        status: string;
        costUsd: number;
        createdAt: Date;
        privateOnly: boolean;
      }>(
        `SELECT r.id, m.id AS "missionId", m.title, r.agent_id AS agent, r.status, r.cost_usd AS "costUsd", r.created_at AS "createdAt",
        (coalesce(r.checkpoint->'loop'->>'privateOnly','false')='true' OR coalesce(r.workflow_node->>'privateOnly','false')='true'
        OR EXISTS (SELECT 1 FROM workflow_runs w WHERE w.run_id=r.id AND w.private_only)) AS "privateOnly"
        FROM runs r JOIN missions m ON m.id=r.mission_id WHERE m.project_id=$1 AND m.id<>$2 AND r.created_at>=$3 ORDER BY r.created_at DESC LIMIT 50`,
        [source.project.id, source.mission.id, since],
      );
      const totals = await db.pool.query<{ cost: number; open: number }>(
        `SELECT (SELECT coalesce(sum(cost_usd),0)::float8 FROM cost_ledger WHERE project_id=$1 AND created_at>=$2) AS cost,
        (SELECT count(*)::int FROM runs r JOIN missions m ON m.id=r.mission_id WHERE m.project_id=$1 AND m.id<>$3 AND r.created_at>=$2 AND r.status NOT IN ('completed','cancelled')) AS open`,
        [source.project.id, since, source.mission.id],
      );
      return {
        since: since.toISOString(),
        costUsd: totals.rows[0]?.cost ?? 0,
        openLoops: totals.rows[0]?.open ?? 0,
        privateOnly:
          source.project.privacy === 'private' || rows.rows.some((row) => row.privateOnly),
        runs: rows.rows.map((row) => ({
          ...row,
          title: secretRedactor.redactText(row.title).slice(0, 160),
          createdAt: row.createdAt.toISOString(),
        })),
      };
    },
  });
}
