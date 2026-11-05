import { describe, expect, it } from 'vitest';
import { validateVerdict, unavailableVerdict } from './review-verdict.js';
import { citedReferences } from './review-evidence.js';

const check = { passed: true, reason: 'Supported by supplied evidence.' };
const verdict = {
  criteria: [
    { ...check, id: 'c1' },
    { ...check, id: 'c2' },
  ],
  grounding: check,
  policy: check,
  tone: check,
  feedback: '',
};
describe('independent Auditor verdict boundaries', () => {
  it('derives acceptance from every criterion and verification check', () => {
    expect(validateVerdict(verdict, ['Summary', 'Risks'], []).accepted).toBe(true);
    for (const key of ['grounding', 'policy', 'tone'] as const) {
      const result = validateVerdict(
        { ...verdict, [key]: { passed: false, reason: `${key} failed` } },
        ['Summary', 'Risks'],
        [],
      );
      expect(result.accepted).toBe(false);
      expect(result.verdict.feedback).toContain(`${key} failed`);
    }
  });
  it.each([
    { ...verdict, criteria: verdict.criteria.slice(0, 1) },
    { ...verdict, criteria: [verdict.criteria[0], verdict.criteria[0]] },
    {
      ...verdict,
      criteria: [
        { ...check, id: 'c1' },
        { ...check, id: 'c3' },
      ],
    },
    { ...verdict, accepted: true },
    { ...verdict, policy: undefined },
  ])('refuses incomplete, duplicated, fabricated or unvalidated verdicts', (input) => {
    expect(() => validateVerdict(input, ['Summary', 'Risks'], [])).toThrow('invalid review');
  });
  it('cannot accept grounding when a citation failed to resolve', () => {
    const result = validateVerdict(
      verdict,
      ['Summary', 'Risks'],
      [
        {
          kind: 'http',
          reference: 'http://127.0.0.1/',
          resolved: false,
          text: 'Blocked',
          privateOnly: false,
        },
      ],
    );
    expect(result.accepted).toBe(false);
    expect(result.verdict.grounding.passed).toBe(false);
  });
  it('recognizes bounded source formats without duplicate fetches', () => {
    const id = '00000000000000000000000001';
    expect(
      citedReferences(
        `See [source](https://example.com/a). https://example.com/a [kb:chk_${id}] art_${id}`,
      ),
    ).toEqual(['https://example.com/a', `kb:chk_${id}`, `art_${id}`]);
  });
  it('makes unavailability explicit without pretending to pass', () => {
    expect(validateVerdict(unavailableVerdict(['Summary']), ['Summary'], []).accepted).toBe(false);
  });
});
