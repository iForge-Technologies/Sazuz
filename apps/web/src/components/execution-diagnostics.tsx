'use client';
import { sandboxDiagnosticsSchema } from '@sazuz/core/sandbox';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '../lib/api';
import { useWorkspaceResource } from '../lib/use-workspace';
import { RequestNotice } from './durable-shared';

export function ExecutionDiagnostics({ setup = false }: { setup?: boolean }) {
  const auth = useQuery({
    queryKey: ['execution-diagnostics-session'],
    queryFn: ({ signal }) =>
      api(
        'auth/get-session',
        z.object({ user: z.object({ id: z.string() }) }).nullable(),
        undefined,
        'GET',
        { signal },
      ),
    enabled: !setup,
    retry: false,
  });
  const result = useWorkspaceResource(
    setup ? 'setup/diagnostics' : 'browser/diagnostics',
    sandboxDiagnosticsSchema,
    setup || !!auth.data,
    false,
  );
  if (!setup && !auth.data)
    return <p>Sign in to view browser, sandbox and hardware diagnostics.</p>;
  const value = result.data;
  return (
    <section className="durable-card" aria-label="Execution diagnostics">
      <h2>Browser and code execution</h2>
      <RequestNotice error={result.error} />
      {!value ? (
        <p>Checking execution services…</p>
      ) : (
        <>
          <dl className="service-details">
            <div>
              <dt>Browser</dt>
              <dd>{value.browser}</dd>
            </div>
            <div>
              <dt>Docker proxy</dt>
              <dd>{value.docker}</dd>
            </div>
            <div>
              <dt>Network proxy</dt>
              <dd>{value.egress}</dd>
            </div>
            <div>
              <dt>Platform</dt>
              <dd>{value.platform}</dd>
            </div>
            <div>
              <dt>Reported system memory</dt>
              <dd>{value.memoryMb.toLocaleString()} MiB</dd>
            </div>
            <div>
              <dt>Available disk</dt>
              <dd>
                {value.freeDiskMb === null ? 'Unknown' : `${value.freeDiskMb.toLocaleString()} MiB`}
              </dd>
            </div>
            <div>
              <dt>GPU</dt>
              <dd>Unknown</dd>
            </div>
          </dl>
          <p>{value.hint}</p>
        </>
      )}
      <button className="secondary" onClick={() => void result.refetch()}>
        Check execution services
      </button>
      {!setup && (
        <p>
          <a href="/browser">Open Browser</a> to manage site profiles and live sessions.
        </p>
      )}
    </section>
  );
}
