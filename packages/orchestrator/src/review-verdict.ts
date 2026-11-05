import { reviewVerdictSchema, type ReviewEvidence, type ReviewVerdict } from '@sazuz/core/reviews';
import { OrchestrationError } from './errors.js';

export function validateVerdict(
  input: unknown,
  acceptance: readonly string[],
  evidence: readonly ReviewEvidence[],
) {
  const parsed = reviewVerdictSchema.safeParse(input);
  if (!parsed.success) throw new OrchestrationError('REVIEW_INVALID');
  const verdict = parsed.data;
  const ids = new Set(verdict.criteria.map((criterion) => criterion.id));
  if (
    verdict.criteria.length !== acceptance.length ||
    ids.size !== acceptance.length ||
    acceptance.some((_, index) => !ids.has(`c${index + 1}`))
  )
    throw new OrchestrationError('REVIEW_INVALID');
  if (evidence.some((entry) => entry.kind !== 'receipt' && !entry.resolved)) {
    verdict.grounding = {
      passed: false,
      reason: 'One or more citations could not be independently resolved within permitted scope.',
    };
    verdict.feedback =
      `${verdict.grounding.reason} Supply available primary evidence or remove unsupported claims. ${verdict.feedback}`.slice(
        0,
        4000,
      );
  }
  const accepted = [...verdict.criteria, verdict.grounding, verdict.policy, verdict.tone].every(
    (entry) => entry.passed,
  );
  if (!accepted && !verdict.feedback.trim())
    verdict.feedback = [...verdict.criteria, verdict.grounding, verdict.policy, verdict.tone]
      .filter((entry) => !entry.passed)
      .map((entry) => entry.reason)
      .join('; ')
      .slice(0, 4000);
  return { accepted, verdict };
}
export function unavailableVerdict(acceptance: readonly string[]): ReviewVerdict {
  const check = { passed: false, reason: 'The independent review was unavailable or incomplete.' };
  return {
    criteria: acceptance.map((_, index) => ({ ...check, id: `c${index + 1}` })),
    grounding: check,
    policy: check,
    tone: check,
    feedback:
      'The independent review could not establish acceptance. Check Auditor/provider availability and review this task before retrying.',
  };
}
