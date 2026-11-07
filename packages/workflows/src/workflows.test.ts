import { describe, expect, it, vi } from 'vitest';
import { s2aGraphSchema, s2aStateSchema } from '@sazuz/core/s2a';
import { generateWorkflow, resolveFields, workflowAllows, workflowObservation } from './s2a.js';
import type { GenerateRequest, GenerateResult } from '@sazuz/llm/contracts';

const graph = {
  entry: 'read',
  nodes: [
    { id: 'read', name: 'Input', kind: 'value', value: '{{input.name}}', next: 'choose' },
    {
      id: 'choose',
      name: 'Branch',
      kind: 'condition',
      left: '{{nodes.read}}',
      right: 'Ada',
      operator: 'equals',
      yes: 'finish',
      no: null,
    },
    {
      id: 'finish',
      name: 'Output',
      kind: 'value',
      value: { greeting: 'Hello {{nodes.read}}' },
      next: null,
    },
  ],
};
const state = () =>
  s2aStateSchema.parse({
    workflowId: 'wf_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    revision: 1,
    graph,
    input: { name: 'Ada' },
    next: 'read',
    outputs: {},
    failure: null,
  });
const request: GenerateRequest = {
  messages: [{ role: 'user', content: 'Run' }],
  remainingBudgetUsd: 1,
};
describe('S2A graph and durable progression', () => {
  it('rejects cycles, missing targets, duplicate IDs and disconnected nodes', () => {
    expect(s2aGraphSchema.safeParse(graph).success).toBe(true);
    expect(
      s2aGraphSchema.safeParse({ ...graph, nodes: [{ ...graph.nodes[0], next: 'read' }] }).success,
    ).toBe(false);
    expect(s2aGraphSchema.safeParse({ ...graph, entry: 'missing' }).success).toBe(false);
    expect(
      s2aGraphSchema.safeParse({ ...graph, nodes: [...graph.nodes, graph.nodes[0]] }).success,
    ).toBe(false);
    expect(
      s2aGraphSchema.safeParse({
        ...graph,
        nodes: [...graph.nodes, { ...graph.nodes[2], id: 'orphan' }],
      }).success,
    ).toBe(false);
  });
  it('executes a conditional data graph without calling a model and survives serialized state', async () => {
    let current = state();
    const model = vi.fn<() => Promise<GenerateResult>>();
    while (current.next) {
      const generated = await generateWorkflow(current, request, model);
      const call = generated.toolCalls[0]!;
      expect(workflowAllows(current, call.name)).toBe(true);
      const value = (call.args as { value: unknown }).value;
      workflowObservation(current, call, { output: value, untrusted: false }, 'done');
      current = s2aStateSchema.parse(JSON.parse(JSON.stringify(current)));
    }
    expect(current.outputs.finish).toEqual({ greeting: 'Hello Ada' });
    expect((await generateWorkflow(current, request, model)).toolCalls).toHaveLength(0);
    expect(model).not.toHaveBeenCalled();
  });
  it('keeps the active node on approval and halts on a denied action', async () => {
    const current = state();
    const call = { id: 's2a:read', name: 's2a.value', args: {} };
    workflowObservation(current, call, { output: null, untrusted: false }, 'waiting_approval');
    expect(current.next).toBe('read');
    workflowObservation(current, call, { output: { denied: true }, untrusted: false }, 'denied');
    await expect(generateWorkflow(current, request, vi.fn())).rejects.toThrow();
  });
  it('maps typed values and rejects prototype access and missing references', () => {
    const current = state();
    current.input.count = 3;
    expect(
      resolveFields({ count: '{{input.count}}', message: 'Count {{input.count}}' }, current),
    ).toEqual({ count: 3, message: 'Count 3' });
    for (const path of ['{{input.__proto__}}', '{{input.constructor}}', '{{nodes.not_run}}'])
      expect(() => resolveFields(path, current)).toThrow();
  });
  it('restricts an agent to its selected tools and finishes its node explicitly', async () => {
    const current = s2aStateSchema.parse({
      ...state(),
      graph: {
        entry: 'agent',
        nodes: [
          {
            id: 'agent',
            name: 'Agent',
            kind: 'agent',
            prompt: 'Summarize',
            agent: 'researcher',
            allowedTools: ['web.search'],
            next: null,
          },
        ],
      },
      next: 'agent',
    });
    const model = vi.fn((input: GenerateRequest) => {
      expect(input.tools?.map((tool) => tool.name)).toEqual(['web.search']);
      return Promise.resolve({
        text: 'Summary',
        toolCalls: [],
        finishReason: 'stop',
        providerId: 'fixture',
        modelId: 'fixture',
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, source: 'provider' },
        costUsd: 0.001,
        costEstimated: false,
        latencyMs: 1,
      } satisfies GenerateResult);
    });
    const result = await generateWorkflow(
      current,
      {
        ...request,
        tools: [
          { name: 'web.search', description: 'Search', inputSchema: {} },
          { name: 'email.send', description: 'Send', inputSchema: {} },
        ],
      },
      model,
    );
    expect(workflowAllows(current, 'email.send')).toBe(false);
    workflowObservation(
      current,
      { id: 's2a:agent', name: 'web.search', args: {} },
      { output: { result: 'Intermediate result' }, untrusted: true },
      'done',
    );
    expect(current.next).toBe('agent');
    expect(current.outputs).not.toHaveProperty('agent');
    expect(result.toolCalls[0]?.name).toBe('s2a.value');
    expect(result.costUsd).toBe(0.001);
  });
});
