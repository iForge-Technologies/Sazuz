import {
  workflowNodeSchema,
  workflowDefinitionSchema,
  type WorkflowAction,
  WorkflowError,
} from '@sazuz/core/workflows';

export const workflowNodeLabels = {
  trigger: 'Trigger',
  tool: 'Tool call',
  agent: 'Agent step',
  skill: 'Skill',
  condition: 'Condition',
  classify: 'Classify',
  map: 'Loop / Map',
  parallel: 'Parallel / Join',
  approval: 'Approval',
  wait: 'Wait',
  transform: 'Transform',
  notify: 'Notify',
  workflow: 'Sub-workflow',
} as const;
export function defaultAction(
  kind: WorkflowAction['kind'],
  reference?: { id: string; revision: number },
): WorkflowAction {
  if ((kind === 'map' || kind === 'workflow') && !reference)
    throw new WorkflowError('WORKFLOW_INVALID');
  const outputSchema = {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
    additionalProperties: false,
  };
  switch (kind) {
    case 'trigger':
      return { kind, trigger: { kind: 'manual' } };
    case 'tool':
      return { kind, agent: 'cos', tool: 'time.now' };
    case 'agent':
      return { kind, agent: 'writer', prompt: 'Summarize the input.', outputSchema };
    case 'skill':
      return {
        kind,
        agent: 'researcher',
        name: 'knowledge-qa',
        revision: 1,
        prompt: 'Answer using the loaded skill.',
        outputSchema,
      };
    case 'condition':
      return { kind, expression: '$exists($input)' };
    case 'classify':
      return {
        kind,
        prompt: 'Choose the appropriate branch for this input.',
        branches: ['yes', 'no'],
      };
    case 'map':
      return {
        kind,
        workflowId: reference!.id,
        revision: reference!.revision,
        items: '$input',
        concurrency: 2,
      };
    case 'workflow':
      return { kind, workflowId: reference!.id, revision: reference!.revision };
    case 'approval':
      return { kind, message: 'Review these results before continuing.' };
    case 'wait':
      return { kind, until: { kind: 'duration', seconds: 60 } };
    case 'transform':
      return { kind, expression: '$input' };
    default:
      return { kind };
  }
}
export function newWorkflowNode(
  kind: WorkflowAction['kind'],
  id: string,
  index: number,
  reference?: { id: string; revision: number },
) {
  return workflowNodeSchema.parse({
    id,
    label: workflowNodeLabels[kind],
    action: defaultAction(kind, reference),
    position: { x: index * 230, y: 0 },
    input: kind === 'tool' ? '{}' : '$input',
  });
}
export const blankWorkflow = () =>
  workflowDefinitionSchema.parse({
    name: 'New workflow',
    nodes: [newWorkflowNode('trigger', 'start', 0)],
    edges: [],
  });
