import { z } from 'zod';
import { createConnectorTools } from '@sazuz/connectors';
import { createBuiltinTools, createMockTools, defineTool, ToolRegistry } from '@sazuz/tools';
import { EvalError, type EvalCase } from '@sazuz/core/evals';

/** Manifests come from shipped tools; suite data cannot choose effects or install executors. */
export function evaluationTools(input: EvalCase, liveAttempt: () => void) {
  const rejectLive = () => {
    liveAttempt();
    throw new EvalError('EVAL_INVALID');
  };
  const registry = createBuiltinTools();
  for (const tool of createConnectorTools({
    getAccounts: rejectLive,
    fetch: rejectLive,
  }))
    registry.register(tool);
  registry.register(
    defineTool({
      name: 'eval.spend',
      description: 'Simulated resource purchase for policy evaluation.',
      input: z.strictObject({ amount: z.number().min(0).max(100), item: z.string().max(100) }),
      output: z.json(),
      effect: 'spend',
      scope: 'external',
      run: rejectLive,
    }),
  );
  registry.register(
    defineTool({
      name: 'eval.unknown',
      description: 'A deliberately undeclared effect for policy evaluation.',
      input: z.strictObject({ target: z.string().max(200) }),
      output: z.json(),
      scope: 'external',
      run: rejectLive,
    }),
  );
  try {
    const selected = new ToolRegistry(
      input.tools.map((name) => ({
        ...registry.get(name),
        execute: rejectLive,
        verify: rejectLive,
      })),
    );
    const fixtures = input.fixtures.map((fixture) => ({
      ...fixture,
      args: selected.parseArgs(fixture.name, fixture.args),
    }));
    for (const turn of input.fixtureTurns)
      for (const call of turn.toolCalls) selected.parseArgs(call.name, call.args);
    return createMockTools(selected, fixtures);
  } catch {
    throw new EvalError('EVAL_INVALID');
  }
}
