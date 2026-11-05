'use client';
import {
  ReactFlow,
  Background,
  Controls,
  Position,
  MarkerType,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { WorkflowDefinition } from '@sazuz/core/workflows';
import { workflowNodeLabels } from '../lib/workflow-editor';

export default function WorkflowDiagram({
  graph,
  selected,
  select,
  move,
  connect,
}: {
  graph: WorkflowDefinition;
  selected: string;
  select: (id: string) => void;
  move: (id: string, position: { x: number; y: number }) => void;
  connect: (from: string, to: string) => void;
}) {
  const nodes: Node[] = graph.nodes.map((node) => ({
    id: node.id,
    position: node.position,
    data: { label: `${node.label}\n${workflowNodeLabels[node.action.kind]}` },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    selected: selected === node.id,
    ariaLabel: `${node.label}, ${workflowNodeLabels[node.action.kind]}`,
    className: 'workflow-node',
  }));
  const edges: Edge[] = graph.edges.map((edge, index) => ({
    id: String(index),
    source: edge.from,
    target: edge.to,
    ...(edge.branch ? { label: edge.branch } : {}),
    markerEnd: { type: MarkerType.ArrowClosed },
  }));
  return (
    <div className="workflow-diagram" role="region" aria-label="Workflow graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        minZoom={0.15}
        maxZoom={1.6}
        onNodeClick={(_event, node) => select(node.id)}
        deleteKeyCode={null}
        onNodeDrag={(_event, node) => move(node.id, node.position)}
        onNodeDragStop={(_event, node) => move(node.id, node.position)}
        onConnect={(connection) => {
          if (connection.source && connection.target) connect(connection.source, connection.target);
        }}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
