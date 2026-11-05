'use client';
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  Position,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { GraphView } from '@sazuz/core/graphs';
import { agentLabels } from './durable-shared';

export default function MissionDiagram({
  graph,
  selected,
  select,
}: {
  graph: GraphView;
  selected: string;
  select: (id: string) => void;
}) {
  const levels = new Map<string, number>();
  const level = (key: string): number => {
    if (levels.has(key)) return levels.get(key)!;
    const task = graph.tasks.find((task) => task.key === key)!;
    const value = task.definition.depends_on.length
      ? 1 + Math.max(...task.definition.depends_on.map(level))
      : 0;
    levels.set(key, value);
    return value;
  };
  const rows = new Map<number, number>();
  const nodes: Node[] = graph.tasks.map((task) => {
    const column = level(task.key),
      row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return {
      id: task.key,
      position: { x: column * 245, y: row * 125 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        label: `${task.key} · ${agentLabels[task.definition.agent]}\n${task.status.replaceAll('_', ' ')} · Attempt ${task.attempt || 1}`,
      },
      ariaLabel: `${task.key}, ${agentLabels[task.definition.agent]}, ${task.status.replaceAll('_', ' ')}`,
      className: `mission-node mission-node-${task.status}${selected === task.key ? ' mission-node-selected' : ''}`,
      selected: selected === task.key,
      draggable: false,
      connectable: false,
    };
  });
  const edges: Edge[] = graph.tasks.flatMap((task) =>
    task.definition.depends_on.map((dependency) => ({
      id: `${dependency}:${task.key}`,
      source: dependency,
      target: task.key,
      markerEnd: { type: MarkerType.ArrowClosed },
      animated: task.status === 'running',
    })),
  );
  return (
    <div className="mission-diagram" role="region" aria-label="Mission task graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        onNodeClick={(_event, node) => select(node.id)}
        minZoom={0.25}
        maxZoom={1.5}
        attributionPosition="bottom-right"
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
