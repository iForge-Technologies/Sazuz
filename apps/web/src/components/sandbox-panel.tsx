'use client';
import { z } from 'zod';
import { sandboxDiagnosticsSchema, sandboxExecutionSchema } from '@sazuz/core/sandbox';
import { useWorkspaceResource } from '../lib/use-workspace';
import { LocalTime, RequestNotice } from './durable-shared';

export function SandboxPanel() {
  const diagnostics = useWorkspaceResource(
    'sandbox/diagnostics',
    sandboxDiagnosticsSchema,
    true,
    false,
  );
  const executions = useWorkspaceResource(
    'sandbox/executions',
    z.array(sandboxExecutionSchema),
    true,
  );
  return (
    <section className="durable-card" aria-label="Sandbox status">
      <h2>Code sandbox</h2>
      <RequestNotice error={diagnostics.error || executions.error} />
      {diagnostics.data && (
        <>
          <p>
            Docker proxy: <strong>{diagnostics.data.docker}</strong> · Network proxy:{' '}
            <strong>{diagnostics.data.egress}</strong>
          </p>
          <p>{diagnostics.data.hint}</p>
        </>
      )}
      <p>
        Choose Analyst or Coder in <a href="/missions">Missions</a>. Network starts off; site
        permissions are under Security → Agent domains. Each code action follows your approval
        policy.
      </p>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          void diagnostics.refetch();
        }}
      >
        Check again
      </button>
      <h3>Recent executions</h3>
      {executions.data?.length === 0 && <p>No code has run yet.</p>}
      {executions.data?.map((item) => (
        <details key={item.id}>
          <summary>
            {item.agentId} · {item.language} · {item.status} · <LocalTime value={item.createdAt} />
          </summary>
          <p>
            Network: {item.network}. <a href="/missions">Open missions</a> to inspect the approved
            code and run.
          </p>
          {item.result && (
            <>
              <p>
                Exit code {item.result.exitCode}
                {item.result.timedOut ? ' · Time limit reached' : ''}
                {item.result.truncated ? ' · Output truncated' : ''}
              </p>
              <pre>{item.result.output || 'No output.'}</pre>
            </>
          )}
        </details>
      ))}
    </section>
  );
}
