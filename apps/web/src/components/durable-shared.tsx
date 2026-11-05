import Link from 'next/link';
import type { AgentRole, Run } from '@sazuz/core/missions';
import { workspaceError } from '../lib/use-workspace';
import { ApiError } from '../lib/api';

export const agentLabels: Record<AgentRole, string> = {
  scheduler: 'Scheduler',
  writer: 'Writer',
  monitor: 'Monitor',
  auditor: 'Auditor',
  cos: 'Chief of Staff',
  researcher: 'Researcher',
  comms: 'Comms',
  coder: 'Coder',
  analyst: 'Analyst',
  operator: 'Operator',
};
export const runLabels: Record<Run['status'], string> = {
  waiting_tasks: 'Specialists working',
  queued: 'Queued',
  running: 'Running',
  waiting_approval: 'Needs approval',
  paused: 'Paused',
  budget_exceeded: 'Budget reached',
  completed: 'Completed',
  failed: 'Needs attention',
  cancelled: 'Cancelled',
};

export function RunStatus({ status }: { status: Run['status'] }) {
  return (
    <span className={`run-status run-status-${status}`} data-run-status={status}>
      {runLabels[status]}
    </span>
  );
}

export function RequestNotice({ error, message }: { error?: unknown; message?: string }) {
  if (!error && !message) return null;
  return (
    <p className="setup-error" role="alert">
      {message || workspaceError(error)}
      {error instanceof ApiError && error.status === 401 && (
        <>
          {' '}
          <Link href="/login">Sign in</Link>
        </>
      )}
    </p>
  );
}

export function LocalTime({ value, timezone }: { value: string | null; timezone?: string }) {
  if (!value) return <span>Not yet</span>;
  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
        ...(timezone ? { timeZone: timezone } : {}),
      }).format(new Date(value))}
    </time>
  );
}
