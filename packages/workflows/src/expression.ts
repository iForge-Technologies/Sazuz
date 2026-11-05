import jsonata from 'jsonata';
import { Validator } from '@cfworker/json-schema';
import { z } from 'zod';
import {
  WorkflowError,
  workflowData,
  workflowExpression,
  type WorkflowDefinition,
} from '@sazuz/core/workflows';
import { secretRedactor } from '@sazuz/vault';

const functions = new Set([
  'count',
  'sum',
  'min',
  'max',
  'average',
  'string',
  'number',
  'boolean',
  'exists',
  'not',
  'length',
  'lowercase',
  'uppercase',
  'trim',
  'substring',
  'substringBefore',
  'substringAfter',
  'contains',
  'split',
  'join',
  'keys',
  'lookup',
  'append',
  'distinct',
  'reverse',
  'sort',
  'merge',
  'type',
  'abs',
  'ceil',
  'floor',
  'round',
]);

/** Reject large/deep data and dangerous keys before any interpreter walks it. */
export function safeData(value: unknown, maxBytes = 32_000) {
  const stack = [{ value, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    if (++count > 4096 || entry.depth > 16) throw new WorkflowError('WORKFLOW_LIMIT');
    if (entry.value && typeof entry.value === 'object')
      for (const [key, child] of Object.entries(entry.value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key))
          throw new WorkflowError('WORKFLOW_INVALID');
        stack.push({ value: child, depth: entry.depth + 1 });
      }
  }
  const parsed = workflowData.parse(value);
  const text = JSON.stringify(parsed);
  if (Buffer.byteLength(text) > maxBytes) throw new WorkflowError('WORKFLOW_LIMIT');
  if (secretRedactor.redactText(text) !== text) throw new WorkflowError('WORKFLOW_INVALID');
  return parsed;
}

function expression(source: string) {
  try {
    const compiled = jsonata(workflowExpression.parse(source), {
      timeout: 100,
      stack: 64,
      sequence: 4096,
    });
    const stack: unknown[] = [compiled.ast()];
    let count = 0;
    while (stack.length) {
      const entry = stack.pop();
      if (++count > 1024) throw new WorkflowError('WORKFLOW_EXPRESSION');
      if (!entry || typeof entry !== 'object') continue;
      const node = entry as Record<string, unknown>;
      if (
        ['lambda', 'bind', 'transform', 'regex', 'regexp', 'apply', 'partial'].includes(
          String(node.type),
        )
      )
        throw new WorkflowError('WORKFLOW_EXPRESSION');
      if (node.value === '..') throw new WorkflowError('WORKFLOW_EXPRESSION');
      if (node.type === 'function') {
        const procedure = node.procedure as Record<string, unknown> | undefined;
        if (procedure?.type !== 'variable' || !functions.has(String(procedure.value)))
          throw new WorkflowError('WORKFLOW_EXPRESSION');
      }
      if (['__proto__', 'prototype', 'constructor'].includes(String(node.value)))
        throw new WorkflowError('WORKFLOW_EXPRESSION');
      for (const child of Object.values(node))
        if (child && typeof child === 'object')
          stack.push(...(Array.isArray(child) ? (child as unknown[]) : [child]));
    }
    return compiled;
  } catch {
    throw new WorkflowError('WORKFLOW_EXPRESSION');
  }
}

export function checkExpression(source: string) {
  expression(source);
}

/** JSONata is interpreted. Fixed functions only; no host callbacks are available to expressions. */
export async function evaluateExpression(
  source: string,
  input: unknown,
  nodes: unknown = {},
  signal?: AbortSignal,
) {
  const data = safeData(input),
    results = safeData(nodes);
  const compiled = expression(source);
  try {
    signal?.throwIfAborted();
    const output: unknown = await compiled.evaluate(data, { input: data, nodes: results });
    signal?.throwIfAborted();
    return safeData(output === undefined ? null : output);
  } catch {
    throw new WorkflowError('WORKFLOW_EXPRESSION');
  }
}

export function outputValidator(schema: Record<string, unknown>) {
  safeData(schema, 12_000);
  const scan = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return;
    for (const [key, value] of Object.entries(entry)) {
      if (
        ['$ref', '$dynamicRef', '$recursiveRef', '$id', 'pattern', 'patternProperties'].includes(
          key,
        )
      )
        throw new WorkflowError('WORKFLOW_INVALID');
      scan(value);
    }
  };
  scan(schema);
  if (schema.type !== 'object') throw new WorkflowError('WORKFLOW_INVALID');
  const validator = new Validator(schema, '2020-12', false);
  return (value: unknown) => {
    const result = safeData(value);
    if (!validator.validate(result).valid) throw new WorkflowError('WORKFLOW_INVALID');
    return z.record(z.string(), z.json()).parse(result);
  };
}
export function validateExpressions(graph: WorkflowDefinition) {
  for (const node of graph.nodes) {
    checkExpression(node.input);
    if (node.pin !== null) safeData(node.pin);
    const action = node.action;
    if (action.kind === 'condition' || action.kind === 'transform')
      checkExpression(action.expression);
    if (action.kind === 'map') checkExpression(action.items);
    if (action.kind === 'agent' || action.kind === 'skill') outputValidator(action.outputSchema);
  }
}
export const needsModel = (graph: WorkflowDefinition) =>
  graph.nodes.some((n) => ['agent', 'skill', 'classify'].includes(n.action.kind));
