import { z } from 'zod';
import { settingsSchemas } from '@sazuz/config/settings';
import type { Approval } from '@sazuz/core/missions';

type PolicyRule = z.infer<typeof settingsSchemas.security>['rules'][number];
const recipients = z.array(z.email()).max(20);

/** Bind every recipient slot and array length; a newly added recipient cannot match. */
export function suggestRecipientRule(
  approval: Approval,
  id: string,
): { rule: PolicyRule; summary: string } | null {
  if (approval.kind !== 'policy' || !/^(?:gmail|email)\.(?:send|draft)$/.test(approval.toolName))
    return null;
  const args = approval.args;
  if (
    typeof args !== 'object' ||
    args === null ||
    Array.isArray(args) ||
    typeof args['accountId'] !== 'string'
  )
    return null;
  const when: PolicyRule['when'] = [
    { field: 'args.accountId', op: 'eq', value: args['accountId'] },
    { field: 'run.tainted', op: 'eq', value: false },
  ];
  const addresses: string[] = [];
  for (const key of ['to', 'cc', 'bcc']) {
    if (args[key] === undefined) {
      if (key === 'to') return null;
      when.push({ field: `args.${key}`, op: 'exists', value: false });
      continue;
    }
    const parsed = recipients.safeParse(args[key]);
    if (!parsed.success || (key === 'to' && !parsed.data.length)) return null;
    when.push({ field: `args.${key}.length`, op: 'eq', value: parsed.data.length });
    parsed.data.forEach((recipient, index) => {
      when.push({ field: `args.${key}.${index}`, op: 'eq', value: recipient });
      addresses.push(recipient);
    });
  }
  const description = `${approval.toolName} from ${args['accountId']} to the reviewed recipient list`;
  const parsed = settingsSchemas.security.shape.rules.unwrap().element.safeParse({
    id,
    description,
    action: 'allow',
    scope: { type: 'agent', projectId: approval.projectId, agentId: approval.agentId },
    match: { tool: approval.toolName, effect: approval.effect },
    when,
  });
  return parsed.success
    ? { rule: parsed.data, summary: `${args['accountId']} → ${addresses.join(', ')}` }
    : null;
}
