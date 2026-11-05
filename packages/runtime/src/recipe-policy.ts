import { recipePolicySchema } from '@sazuz/core/missions';
import type { PolicyRequest } from '@sazuz/policy';
import type { Database } from '@sazuz/db';

/** Persisted recipe restrictions can only narrow the configured Policy Engine authority. */
export function recipePolicyInput(
  value: unknown,
): Pick<PolicyRequest, 'allowedEffects' | 'askEffects'> {
  if (value === null || value === undefined) return {};
  const policy = recipePolicySchema.parse(value);
  return policy === 'read_only'
    ? { allowedEffects: ['read'] }
    : policy === 'draft_send'
      ? { allowedEffects: ['read', 'send'], askEffects: ['send'] }
      : {
          allowedEffects: ['read', 'write', 'send', 'delete', 'publish'],
          askEffects: ['write', 'send', 'delete', 'publish'],
        };
}

/** Referenced workflow restrictions remain effective inside an unrestricted parent mission. */
export async function inheritedRecipePolicy(db: Database, runId: string, missionPolicy: unknown) {
  return recipePolicyInput(await inheritedRecipePolicyValue(db, runId, missionPolicy));
}

export async function inheritedRecipePolicyValue(
  db: Database,
  runId: string,
  missionPolicy: unknown,
) {
  const rows = await db.pool.query<{ policy: string | null }>(
    `WITH RECURSIVE ancestors AS (
    SELECT id,parent_run_id FROM runs WHERE id=$1
    UNION SELECT r.id,r.parent_run_id FROM runs r JOIN ancestors a ON r.id=a.parent_run_id
  ) SELECT w.snapshot -> (w.workflow_id || ':' || w.revision) ->> 'policy' AS policy
    FROM workflow_runs w JOIN ancestors a ON a.id=w.run_id`,
    [runId],
  );
  const values = [missionPolicy, ...rows.rows.map((row) => row.policy)]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => recipePolicySchema.parse(value));
  return values.includes('read_only')
    ? 'read_only'
    : values.includes('draft_send')
      ? 'draft_send'
      : values.includes('review_changes')
        ? 'review_changes'
        : null;
}
