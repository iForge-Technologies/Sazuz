import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import {
  EvalError,
  evalSuiteSchema,
  evalSuiteSummarySchema,
  type EvalSuite,
} from '@sazuz/core/evals';
import { secretRedactor } from '@sazuz/vault';
import inbox from '../../../evals/inbox-triage.json' with { type: 'json' };
import research from '../../../evals/research.json' with { type: 'json' };
import workflows from '../../../evals/workflows.json' with { type: 'json' };
import redTeam from '../../../evals/red-team.json' with { type: 'json' };

function bounded(value: unknown, depth = 0): void {
  if (depth > 16) throw new EvalError('EVAL_INVALID');
  if (Array.isArray(value)) {
    for (const item of value) bounded(item, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new EvalError('EVAL_INVALID');
      bounded(item, depth + 1);
    }
  }
}
export function parseSuite(input: unknown): EvalSuite {
  try {
    bounded(input);
    if (Buffer.byteLength(JSON.stringify(input)) > 256_000) throw new EvalError('EVAL_INVALID');
    return evalSuiteSchema.parse(secretRedactor.redact(input));
  } catch {
    throw new EvalError('EVAL_INVALID');
  }
}
export function parseSuiteText(source: string): EvalSuite {
  if (Buffer.byteLength(source) > 256_000) throw new EvalError('EVAL_INVALID');
  try {
    const document = parseDocument(source, { strict: true, uniqueKeys: true });
    if (document.errors.length) throw new EvalError('EVAL_INVALID');
    return parseSuite(document.toJS({ maxAliasCount: 0 }));
  } catch {
    throw new EvalError('EVAL_INVALID');
  }
}
export const suiteHash = (suite: EvalSuite) =>
  createHash('sha256').update(JSON.stringify(suite)).digest('hex');
export const suiteSummary = (suite: EvalSuite) =>
  evalSuiteSummarySchema.parse({
    suite: suite.suite,
    version: suite.version,
    description: suite.description,
    hash: suiteHash(suite),
    cases: suite.cases.length,
    presets: suite.model_presets,
  });
export function builtinSuites(includeRedTeam = false): EvalSuite[] {
  return [inbox, research, workflows, ...(includeRedTeam ? [redTeam] : [])].map(parseSuite);
}
export function selectSuites(names: string[]) {
  const suites = builtinSuites(true);
  const selected =
    names.length === 1 && names[0] === 'all'
      ? builtinSuites()
      : names.map((name) => suites.find((suite) => suite.suite === name));
  if (
    !selected.length ||
    selected.some((suite) => !suite) ||
    new Set(selected.map((suite) => suite!.suite)).size !== selected.length
  )
    throw new EvalError('EVAL_INVALID');
  return selected as EvalSuite[];
}
