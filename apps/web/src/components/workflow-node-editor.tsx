'use client';
import { useState } from 'react';
import { workflowNodeSchema, type WorkflowNode } from '@sazuz/core/workflows';

export function WorkflowNodeEditor({
  node,
  save,
  remove,
}: {
  node: WorkflowNode;
  save: (node: WorkflowNode) => void;
  remove: () => void;
}) {
  const [label, setLabel] = useState(node.label),
    [input, setInput] = useState(node.input);
  const [action, setAction] = useState(JSON.stringify(node.action, null, 2));
  const [attempts, setAttempts] = useState(node.retry.attempts),
    [delay, setDelay] = useState(node.retry.delaySeconds);
  const [timeout, setTimeout] = useState(node.retry.timeoutSeconds);
  const [pinned, setPinned] = useState(node.pin !== null),
    [pin, setPin] = useState(JSON.stringify(node.pin ?? {}, null, 2));
  const [error, setError] = useState('');
  return (
    <form
      className="workflow-node-editor"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const value = workflowNodeSchema.parse({
            ...node,
            label,
            input,
            action: JSON.parse(action) as unknown,
            retry: { attempts, delaySeconds: delay, timeoutSeconds: timeout },
            pin: pinned ? (JSON.parse(pin) as unknown) : null,
          });
          save(value);
          setError('');
        } catch {
          setError('Check the node configuration, JSON, retry limits and timeout.');
        }
      }}
    >
      <h3>Configure {node.id}</h3>
      {error && (
        <p role="alert" className="setup-error">
          {error}
        </p>
      )}
      <label className="setup-field">
        Node label
        <input value={label} maxLength={100} onChange={(event) => setLabel(event.target.value)} />
      </label>
      <label className="setup-field">
        Input expression
        <textarea value={input} rows={2} onChange={(event) => setInput(event.target.value)} />
      </label>
      <p className="field-help">
        Use $input for workflow input and $nodes.node_id for earlier results. Tool inputs must match
        the tool’s arguments.
      </p>
      <label className="setup-field">
        Action configuration (JSON)
        <textarea
          spellCheck={false}
          value={action}
          rows={12}
          onChange={(event) => setAction(event.target.value)}
        />
      </label>
      <p className="field-help">
        Triggers support manual, cron, RSS, IMAP and signed webhooks. Wait until a duration, time or
        named event. Sub-workflows and skills require an exact revision.
      </p>
      <div className="workflow-retry">
        <label className="setup-field">
          Attempts
          <input
            type="number"
            min={1}
            max={3}
            value={attempts}
            onChange={(e) => setAttempts(Number(e.target.value))}
          />
        </label>
        <label className="setup-field">
          Retry delay (seconds)
          <input
            type="number"
            min={0}
            max={3600}
            value={delay}
            onChange={(e) => setDelay(Number(e.target.value))}
          />
        </label>
        <label className="setup-field">
          Timeout (seconds)
          <input
            type="number"
            min={1}
            max={86400}
            value={timeout}
            onChange={(e) => setTimeout(Number(e.target.value))}
          />
        </label>
      </div>
      <label className="setup-check">
        <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
        Pin test output
      </label>
      {pinned && (
        <label className="setup-field">
          Test output (JSON)
          <textarea value={pin} rows={4} onChange={(e) => setPin(e.target.value)} />
        </label>
      )}
      <p className="field-help">
        Pinned outputs apply only to test runs and appear as mocked in history.
      </p>
      <div className="durable-actions">
        <button type="submit">Apply node changes</button>
        {node.action.kind !== 'trigger' && (
          <button type="button" className="secondary operation-danger" onClick={remove}>
            Remove node
          </button>
        )}
      </div>
    </form>
  );
}
