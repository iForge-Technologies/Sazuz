const messages = {
  SKILL_INVALID:
    'Use a bounded SKILL.md with valid name, description, version, inputs, tools and permissions.',
  SKILL_NOT_FOUND: 'This skill or revision is unavailable.',
  SKILL_CONFLICT: 'This skill changed or its name is reserved. Reload before saving.',
  SKILL_SECRET: 'Store credentials in the vault, not in skills or writing samples.',
  SKILL_LIMIT: 'This workspace has reached the limit of 200 authored skills.',
  STYLE_CONFLICT: 'This preview request was already used with different samples.',
  STYLE_BUSY:
    'Other work is in progress. No model call was made for this preview; try again shortly.',
  STYLE_BUDGET: 'Style preview is paused or does not fit the configured spending limits.',
  STYLE_FAILED:
    'The preview could not finish. Check the Fast model, budget and vault, then request a new preview.',
  STYLE_INTERRUPTED: 'The preview was interrupted. A new preview may make another model call.',
  STYLE_SOURCE_NOT_FOUND:
    'Select a confirmed sent message from this project, or paste a sent-message export.',
  STYLE_UNAVAILABLE: 'Accept and enable a writing-style profile before comparing drafts.',
  STYLE_CHECK_CONFLICT:
    'This comparison request or vote was already used. Reload its saved result.',
  STYLE_CHECK_FAILED:
    'The comparison did not finish. Its recorded costs are retained; a new comparison requires a new request.',
} as const;
export class SkillError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'SkillError';
  }
}
