import type { missionDetailSchema } from '@sazuz/core/missions';
import type { z } from 'zod';
import { agentLabels, LocalTime } from './durable-shared';
import { formatCost } from './chat-messages';
import { CitedText } from './cited-text';
import Link from 'next/link';

export function MissionTimeline({ detail }: { detail: z.infer<typeof missionDetailSchema> }) {
  return (
    <>
      <section className="mission-timeline" aria-label="Mission timeline">
        <h3>Step timeline</h3>
        {!detail.steps.length && (
          <p className="work-muted">
            The first step will appear when a worker starts this mission.
          </p>
        )}
        <ol>
          {detail.steps.map((step, index) => (
            <li key={step.id}>
              <article aria-label={`Step ${index + 1}`}>
                <header>
                  <span className="step-index" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <strong>
                    {step.kind === 'tool'
                      ? (step.toolName ?? 'Tool result')
                      : step.kind === 'plan'
                        ? 'Mission plan'
                        : step.kind === 'status'
                          ? 'Status update'
                          : agentLabels[step.agentId]}
                  </strong>
                  <span className="work-tag">{agentLabels[step.agentId]}</span>
                  <LocalTime value={step.createdAt} />
                  <Link href={`/runs/${step.runId}`}>Inspect or fork run</Link>
                </header>
                {step.content && (
                  <p className="message-content">
                    <CitedText text={step.content} />
                  </p>
                )}
                {step.prompt && (
                  <details className="tool-observation">
                    <summary>Model prompt</summary>
                    <pre>{step.prompt}</pre>
                  </details>
                )}
                {(step.toolArgs !== null || step.toolResult !== null) && (
                  <details className="tool-observation">
                    <summary>Action details</summary>
                    {step.toolArgs !== null && (
                      <>
                        <h4>Arguments</h4>
                        <pre>{JSON.stringify(step.toolArgs, null, 2)}</pre>
                      </>
                    )}
                    {step.toolResult !== null && (
                      <>
                        <h4>Result</h4>
                        <pre>
                          {typeof step.toolResult === 'string'
                            ? step.toolResult
                            : JSON.stringify(step.toolResult, null, 2)}
                        </pre>
                      </>
                    )}
                  </details>
                )}
                {step.kind === 'assistant' && (
                  <footer className="message-usage">
                    <span>
                      {step.providerId ?? 'Provider unavailable'} /{' '}
                      {step.modelId ?? 'Model unavailable'}
                    </span>
                    <span>
                      {step.inputTokens.toLocaleString()} input ·{' '}
                      {step.outputTokens.toLocaleString()} output tokens
                    </span>
                    <span>{formatCost(step.costUsd)}</span>
                  </footer>
                )}
              </article>
            </li>
          ))}
        </ol>
      </section>
      {detail.agentMessages.length > 0 && (
        <section className="agent-handoffs" aria-label="Team activity">
          <h3>Team conversation</h3>
          <ol>
            {detail.agentMessages.map((message) => (
              <li key={message.id}>
                <strong>
                  {message.from === 'user' ? 'You' : agentLabels[message.from]} →{' '}
                  {message.to === 'user' ? 'You' : agentLabels[message.to]}
                </strong>
                <span className="work-tag">
                  {message.type.replaceAll('_', ' ')}
                  {message.taskId ? ` · ${message.taskId}` : ''}
                </span>
                <p className="message-content">{message.content}</p>
                {message.payload !== null && (
                  <details className="tool-observation">
                    <summary>Message details</summary>
                    <pre>{JSON.stringify(message.payload, null, 2)}</pre>
                  </details>
                )}
                <LocalTime value={message.createdAt} />
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}
