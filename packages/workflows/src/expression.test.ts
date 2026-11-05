import { describe, expect, it } from 'vitest';
import { workflowDefinitionSchema } from '@sazuz/core/workflows';
import { evaluateExpression, checkExpression, outputValidator, safeData } from './expression.js';

describe('bounded workflow data and interpreted expressions', () => {
  it('maps input and earlier node results without executing source code', async () => {
    expect(
      await evaluateExpression(
        '{"total": $sum($input.items), "name": $nodes.source.name}',
        { items: [2, 3, 5] },
        { source: { name: 'quoted <untrusted>' } },
      ),
    ).toEqual({ total: 10, name: 'quoted <untrusted>' });
    expect(await evaluateExpression('$input.count > 2', { count: 3 })).toBe(true);
  });
  it.each([
    '$eval("1+1")',
    'function($x){$x} (1)',
    '[1..999999999]',
    '$input.constructor',
    '$match("x", /a+/)',
    '$replace("abc", /a/, "z")',
    '($x := 1; $x)',
    '$unknown()',
  ])('rejects unsafe or expansive expression %s', (source) => {
    expect(() => checkExpression(source)).toThrow();
  });
  it('enforces input, depth, result and cancellation limits', async () => {
    let deep: unknown = null;
    for (let depth = 0; depth < 18; depth++) deep = { deep };
    expect(() => safeData(deep)).toThrow();
    expect(() => safeData({ text: 'x'.repeat(33000) })).toThrow();
    await expect(evaluateExpression('$input', {}, {}, AbortSignal.abort())).rejects.toThrow();
    await expect(
      evaluateExpression('$input.x & $input.x', { x: 'a'.repeat(18000) }),
    ).rejects.toThrow();
  });
  it('interprets bounded object output schemas and rejects external schema references', () => {
    const validate = outputValidator({
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
      additionalProperties: false,
    });
    expect(validate({ count: 2 })).toEqual({ count: 2 });
    expect(() => validate({ count: 'wrong' })).toThrow();
    expect(() =>
      outputValidator({ type: 'object', $ref: 'https://example.test/schema' }),
    ).toThrow();
  });
  it('rejects cycles, dangling edges, duplicate nodes and unlabelled condition branches', () => {
    const node = (id: string, kind: 'trigger' | 'transform') => ({
      id,
      label: id,
      position: { x: 0, y: 0 },
      action:
        kind === 'trigger' ? { kind, trigger: { kind: 'manual' } } : { kind, expression: '$input' },
    });
    const graph = {
      name: 'checked',
      nodes: [node('start', 'trigger'), node('one', 'transform'), node('two', 'transform')],
      edges: [
        { from: 'start', to: 'one' },
        { from: 'one', to: 'two' },
      ],
    };
    expect(workflowDefinitionSchema.safeParse(graph).success).toBe(true);
    expect(
      workflowDefinitionSchema.safeParse({
        ...graph,
        edges: [...graph.edges, { from: 'two', to: 'one' }],
      }).success,
    ).toBe(false);
    expect(
      workflowDefinitionSchema.safeParse({
        ...graph,
        nodes: [...graph.nodes, node('one', 'transform')],
      }).success,
    ).toBe(false);
    expect(
      workflowDefinitionSchema.safeParse({
        ...graph,
        edges: [...graph.edges, { from: 'two', to: 'absent' }],
      }).success,
    ).toBe(false);
  });
});
