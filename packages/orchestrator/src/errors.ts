import { SazuzError } from '@sazuz/core';
const messages = {
  AGENT_INVALID: 'Check the agent definition, permissions and budgets.',
  AGENT_SECRET:
    'Agent definitions must not contain credentials. Choose accounts configured in Settings.',
  AGENT_NOT_FOUND: 'This agent or revision is unavailable.',
  AGENT_CONFLICT: 'The agent changed. Reload before saving.',
  AGENT_DISABLED: 'This agent is disabled. Enable it in Agents before continuing.',
  AGENT_SCOPE_DENIED: 'This agent does not have the required tool and account permission.',
  GRAPH_INVALID: 'The task graph or revision is invalid.',
  GRAPH_NOT_FOUND: 'This mission graph is unavailable.',
  GRAPH_BUDGET: 'The mission budget does not admit more work.',
  GRAPH_UNCERTAIN:
    'An earlier task action has an uncertain outcome. Reconcile it before replanning.',
  GRAPH_REPLAN_LIMIT: 'Automatic replanning is exhausted. Review the mission before continuing.',
  REVIEW_INVALID: 'The Auditor returned an incomplete or invalid review.',
  REVIEW_STALE: 'Review settings or evidence privacy changed. Resume to obtain a fresh review.',
  REVIEW_BUDGET: 'The shared step budget or Auditor allowance was reached before review.',
  REVIEW_LIMIT:
    'The interrupted review exhausted its two attempts. Review the task before continuing.',
} as const;
export class OrchestrationError extends SazuzError {
  constructor(code: keyof typeof messages) {
    super(code, messages[code]);
  }
}
