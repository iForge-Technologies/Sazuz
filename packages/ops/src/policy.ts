import { evaluatePolicy } from '@sazuz/policy';
import { auditLog, getControl, readSettings, workKey, type Database } from '@sazuz/db';
import { OperationsError } from '@sazuz/core/operations';

export async function admitOperation(
  db: Database,
  input: {
    actorId: string;
    id: string;
    action: 'backup' | 'restore' | 'prune' | 'update';
    explicit: boolean;
  },
) {
  const settings = await readSettings(db);
  const scheduled = !input.explicit;
  if (
    scheduled &&
    (!settings.backups.value.enabled || (input.action === 'prune' && !settings.backups.value.prune))
  )
    throw new OperationsError('OPS_POLICY');
  const effect = input.action === 'restore' || input.action === 'prune' ? 'delete' : 'write';
  // The saved schedule is a standing grant for this fixed local action. Custom rules still narrow it.
  const decision = evaluatePolicy({
    tool: `operations.${input.action}`,
    effect,
    scope: 'internal',
    agentId: 'operations',
    projectId: 'workspace',
    tainted: false,
    preset: scheduled && input.action === 'backup' ? 'balanced' : settings.security.value.preset,
    args: { operationId: input.id },
    rules: settings.security.value.rules,
    paused: scheduled && (await getControl(db)).paused,
  });
  await db.orm.insert(auditLog).values({
    id: workKey('aud'),
    actorId: input.actorId,
    action: `policy.${decision.action}`,
    target: input.id,
  });
  const consent =
    decision.action === 'ask' &&
    (input.explicit ||
      (input.action === 'prune' &&
        settings.backups.value.prune &&
        decision.ruleId.startsWith('preset:')));
  if (decision.action !== 'allow' && !consent) throw new OperationsError('OPS_POLICY');
  if (consent)
    await db.orm.insert(auditLog).values({
      id: workKey('aud'),
      actorId: input.actorId,
      action: 'operation.approved',
      target: input.id,
    });
}
