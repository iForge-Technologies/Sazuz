import { describe, expect, it } from 'vitest';
import { builtinSuites, parseSuite, parseSuiteText, selectSuites } from './loader.js';
import { createFixturePlan } from './offline.js';

describe('bounded evaluation suites', () => {
  it('loads versioned JSON and YAML through strict schemas', () => {
    const suite = builtinSuites()[0]!;
    expect(parseSuiteText(JSON.stringify(suite))).toEqual(suite);
    expect(() => parseSuiteText('version: 1\nsuite: invalid')).toThrow();
  });
  it('rejects duplicate keys, aliases, excessive nesting, oversized inputs and prototype keys', () => {
    for (const value of [
      'suite: one\nsuite: two',
      'value: &item [x]\nother: *item',
      'x'.repeat(256_001),
    ])
      expect(() => parseSuiteText(value)).toThrow();
    const deeplyNested = Array.from({ length: 18 }).reduce<unknown>((value) => [value], 0);
    expect(() => parseSuite(deeplyNested)).toThrow();
    expect(() => parseSuite(JSON.parse('{"__proto__": {"admin": true}}'))).toThrow();
  });
  it('rejects unknown suites, duplicate presets, invalid tools and oversized case matrices', () => {
    expect(() => selectSuites(['missing'])).toThrow();
    expect(() => selectSuites(['inbox-triage', 'inbox-triage'])).toThrow();
    expect(() => createFixturePlan(builtinSuites(), ['balanced', 'balanced'])).toThrow();
    const suite = builtinSuites()[0]!;
    expect(() =>
      parseSuite({ ...suite, cases: [{ ...suite.cases[0], effect: 'read' }] }),
    ).toThrow();
    expect(() => parseSuite({ ...suite, cases: [suite.cases[0], suite.cases[0]] })).toThrow();
  });
});
