import type { WorkMessage } from '@sazuz/core/work';
import { CitedText } from './cited-text';
import type { SettingsDocument } from '@sazuz/config/settings';
import { VoicePlayback } from './voice-controls';
import { Icon } from './icons';

export type LiveTool = {
  id: string;
  name: string;
  args?: unknown;
  output?: unknown;
  status: 'running' | 'done' | 'denied' | 'waiting_approval' | 'error';
};

export function formatCost(cost: number): string {
  return `$${cost.toFixed(cost > 0 && cost < 0.01 ? 6 : 4)}`;
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? '';
}

export function ToolObservation({ tool }: { tool: LiveTool }) {
  const label = {
    running: 'Running',
    done: 'Complete',
    denied: 'Denied by policy',
    waiting_approval: 'Waiting for approval',
    error: 'Could not finish',
  }[tool.status];
  return (
    <details
      className="tool-observation"
      data-tool-status={tool.status}
      open={tool.status === 'waiting_approval'}
    >
      <summary>
        <strong>{tool.name}</strong>
        <span>{label}</span>
      </summary>
      {tool.args !== undefined && (
        <>
          <h4>Arguments</h4>
          <pre>{printable(tool.args)}</pre>
        </>
      )}
      {tool.output !== undefined && (
        <>
          <h4>Result</h4>
          <pre>{printable(tool.output)}</pre>
        </>
      )}
      {tool.status === 'waiting_approval' && <p>This action is paused until it is approved.</p>}
    </details>
  );
}

export function ChatMessage({
  message,
  speech,
}: {
  message: WorkMessage;
  speech?: SettingsDocument | null;
}) {
  return (
    <article
      className={`chat-message chat-message-${message.role}`}
      aria-label={`${message.role} message`}
    >
      <header>
        <span className={`message-avatar message-avatar-${message.role}`} aria-hidden="true">
          {message.role === 'user' ? (
            'Y'
          ) : message.role === 'tool' ? (
            <Icon name="workflows" />
          ) : (
            'S'
          )}
        </span>
        <strong>
          {message.role === 'user' ? 'You' : message.role === 'tool' ? 'Tool result' : 'Sazuz'}
        </strong>
        {message.trust === 'untrusted' && <span className="work-tag">External content</span>}
      </header>
      {message.content && (
        <p className="message-content">
          <CitedText text={message.content} />
        </p>
      )}
      {message.toolCalls.map((tool) => (
        <details className="tool-observation" key={tool.id}>
          <summary>Tool call · {tool.name}</summary>
          <pre>{printable(tool.args)}</pre>
        </details>
      ))}
      {message.role === 'assistant' && (
        <footer className="message-usage" aria-label="Message usage">
          <span>
            {message.providerId ?? 'Unknown provider'} / {message.modelId ?? 'Unknown model'}
          </span>
          <span>
            {message.inputTokens.toLocaleString()} input · {message.outputTokens.toLocaleString()}{' '}
            output tokens
          </span>
          <span>
            {formatCost(message.costUsd)}
            {message.usageEstimated ? ' · estimated' : ''}
          </span>
        </footer>
      )}
      {message.role === 'assistant' && message.content.length <= 4000 && speech && (
        <VoicePlayback settings={speech} messageId={message.id} />
      )}
    </article>
  );
}
