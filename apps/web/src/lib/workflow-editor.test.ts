import { describe, expect, it } from 'vitest';
import { workflowDefinitionSchema, workflowNodeSchema } from '@sazuz/core/workflows';
import { blankWorkflow, newWorkflowNode, workflowNodeLabels } from './workflow-editor';

describe('workflow editor defaults', () => {
  it('provides an editable node configuration for every supported family', () => {
    const kinds = Object.keys(workflowNodeLabels) as (keyof typeof workflowNodeLabels)[];
    expect(kinds).toHaveLength(13);
    for (const kind of kinds)
      expect(
        workflowNodeSchema.safeParse(
          newWorkflowNode(kind, 'example', 0, { id: 'wf_00000000000000000000000001', revision: 2 }),
        ).success,
      ).toBe(true);
  });
  it('requires an explicitly selected sub-workflow instead of inventing a reference', () => {
    expect(() => newWorkflowNode('map', 'example', 0)).toThrow();
    expect(
      newWorkflowNode('workflow', 'example', 0, {
        id: 'wf_00000000000000000000000001',
        revision: 2,
      }).action,
    ).toMatchObject({ revision: 2 });
  });
  it('starts with a valid inert manual graph', () => {
    expect(workflowDefinitionSchema.parse(blankWorkflow()).nodes[0]?.action).toEqual({
      kind: 'trigger',
      trigger: { kind: 'manual' },
    });
  });
});
