'use client';

import type { Health } from '@sazuz/core/health';
import { Badge, Button, type BadgeProps } from '@sazuz/ui';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { fetchHealth } from '../lib/health-client';
import { HealthRequestError } from '../lib/health-response';
import { useHealthViewStore } from '../lib/health-view-store';
import { Icon } from './icons';
import { WorkHeader } from './work-header';
import { ExecutionDiagnostics } from './execution-diagnostics';

type ViewStatus = Health['status'] | 'checking' | 'unavailable';
type BadgeTone = NonNullable<BadgeProps['tone']>;

const summaries: Record<ViewStatus, { title: string; label: string; tone: BadgeTone }> = {
  checking: { title: 'Checking your services', label: 'Checking', tone: 'neutral' },
  ok: { title: 'Core services operational', label: 'Operational', tone: 'success' },
  degraded: { title: 'Services need attention', label: 'Degraded', tone: 'warning' },
  unavailable: { title: 'Health check unavailable', label: 'Unavailable', tone: 'danger' },
};

function summaryDescription(
  status: ViewStatus,
  health: Health | undefined,
  invalidResponse: boolean,
): string {
  if (status === 'checking') return 'Waiting for a verified response from your instance.';
  if (status === 'ok') return 'The database is reachable and your worker is reporting in.';
  if (status === 'unavailable') {
    return invalidResponse
      ? 'The latest response could not be verified. Refresh to try again.'
      : 'Your instance could not be reached. Check that the server is running, then refresh.';
  }
  if (health?.services.database.status === 'error') {
    return 'The database check failed. Worker status may be unavailable until it recovers.';
  }
  if (health?.services.worker.status === 'missing') {
    return 'No active worker is reporting in. Start a worker to restore service.';
  }
  if (health?.services.worker.status === 'stale') {
    return 'The latest worker heartbeat is out of date. Check the worker process.';
  }
  return 'One or more services is not ready. Review the checks below.';
}

function CheckTime({
  timestamp,
  fallback = 'Not available',
}: {
  timestamp?: string | null;
  fallback?: string;
}) {
  if (!timestamp) return <span>{fallback}</span>;
  const date = new Date(timestamp);
  return (
    <time dateTime={timestamp} title={date.toLocaleString()}>
      {new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      }).format(date)}
    </time>
  );
}

function DatabaseCard({ health, checking }: { health: Health | undefined; checking: boolean }) {
  const database = health?.services.database;
  const ready = database?.status === 'ok';
  const label = database
    ? ready
      ? 'Operational'
      : 'Unavailable'
    : checking
      ? 'Checking'
      : 'Unknown';
  const tone: BadgeTone = database ? (ready ? 'success' : 'danger') : 'neutral';

  return (
    <article className="service-card" aria-labelledby="database-title">
      <div className="service-card-heading">
        <div className="service-identity">
          <span className="service-icon">
            <Icon name="database" />
          </span>
          <div>
            <h3 id="database-title">Database</h3>
            <p>PostgreSQL + pgvector</p>
          </div>
        </div>
        <Badge tone={tone}>
          <span className="status-dot" />
          {label}
        </Badge>
      </div>
      <p className="service-description">
        {database
          ? ready
            ? 'Connection and vector extension are ready.'
            : 'The database readiness check failed.'
          : checking
            ? 'Waiting for the database check to finish.'
            : 'A current database result is not available.'}
      </p>
      <dl className="service-details">
        <div>
          <dt>Check duration</dt>
          <dd>
            {database
              ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(database.latencyMs)} ms`
              : 'Not available'}
          </dd>
        </div>
        <div>
          <dt>Last checked</dt>
          <dd>
            <CheckTime timestamp={health?.checkedAt ?? null} />
          </dd>
        </div>
      </dl>
    </article>
  );
}

const workerLabels: Record<
  Health['services']['worker']['status'],
  { label: string; tone: BadgeTone; description: string }
> = {
  ok: {
    label: 'Operational',
    tone: 'success',
    description: 'A recent heartbeat confirms the worker is online.',
  },
  missing: {
    label: 'No heartbeat',
    tone: 'warning',
    description: 'No worker heartbeat has been received.',
  },
  stale: {
    label: 'Stale heartbeat',
    tone: 'warning',
    description: 'The last heartbeat is too old to confirm readiness.',
  },
  unavailable: {
    label: 'Unknown',
    tone: 'neutral',
    description: 'Worker status could not be checked.',
  },
};

function WorkerCard({ health, checking }: { health: Health | undefined; checking: boolean }) {
  const worker = health?.services.worker;
  const state = worker
    ? workerLabels[worker.status]
    : {
        label: checking ? 'Checking' : 'Unknown',
        tone: 'neutral' as const,
        description: checking
          ? 'Waiting for the worker check to finish.'
          : 'A current worker result is not available.',
      };

  return (
    <article className="service-card" aria-labelledby="worker-title">
      <div className="service-card-heading">
        <div className="service-identity">
          <span className="service-icon">
            <Icon name="worker" />
          </span>
          <div>
            <h3 id="worker-title">Worker</h3>
            <p>Background service</p>
          </div>
        </div>
        <Badge tone={state.tone}>
          <span className="status-dot" />
          {state.label}
        </Badge>
      </div>
      <p className="service-description">{state.description}</p>
      <dl className="service-details">
        <div>
          <dt>Active workers</dt>
          <dd>
            {worker && worker.status !== 'unavailable' ? worker.activeCount : 'Not available'}
          </dd>
        </div>
        <div>
          <dt>Latest heartbeat</dt>
          <dd>
            <CheckTime
              timestamp={worker?.lastSeenAt ?? null}
              fallback={worker?.status === 'missing' ? 'Not received' : 'Not available'}
            />
          </dd>
        </div>
      </dl>
    </article>
  );
}

export function HealthPage({ children }: { children?: ReactNode }) {
  const autoRefresh = useHealthViewStore((state) => state.autoRefresh);
  const toggleAutoRefresh = useHealthViewStore((state) => state.toggleAutoRefresh);
  const query = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => fetchHealth(signal),
    retry: false,
    staleTime: 5_000,
    refetchInterval: autoRefresh ? 10_000 : false,
    refetchOnWindowFocus: autoRefresh,
    refetchOnReconnect: autoRefresh,
    networkMode: 'always',
  });
  // A failed refresh invalidates the current display; retained query data is not fresh health.
  const health = query.isError ? undefined : query.data;
  const status: ViewStatus = query.isError ? 'unavailable' : (health?.status ?? 'checking');
  const summary = summaries[status];
  const invalidResponse =
    query.error instanceof HealthRequestError && query.error.code === 'invalid-response';

  return (
    <div className="app-shell work-shell health-shell" data-work-page="health">
      <WorkHeader current="Health" contentId="main" publicPage />
      <main id="main" className="main-content" tabIndex={-1}>
        {children}
        <div className="page-heading">
          <div>
            <p className="eyebrow">YOUR INSTANCE</p>
            <h1>System health</h1>
            <p className="page-description">
              Live checks for your database and background workers.
            </p>
          </div>
          <div className="page-actions">
            <Button
              variant="ghost"
              size="small"
              onClick={toggleAutoRefresh}
              aria-pressed={autoRefresh}
              aria-label="Automatic refresh"
            >
              <Icon name={autoRefresh ? 'pause' : 'play'} />
              {autoRefresh ? 'Auto-refresh on' : 'Auto-refresh paused'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                void query.refetch();
              }}
              disabled={query.isFetching}
              aria-label="Refresh health"
              aria-busy={query.isFetching}
            >
              <Icon name="refresh" className={query.isFetching ? 'refreshing' : ''} />
              {query.isFetching ? 'Checking…' : 'Refresh'}
            </Button>
          </div>
        </div>

        <section
          className="health-summary"
          data-health-status={status}
          aria-labelledby="summary-title"
        >
          <span className={`summary-icon summary-icon-${status}`}>
            <Icon name={status === 'ok' ? 'check' : status === 'checking' ? 'activity' : 'alert'} />
          </span>
          <div className="summary-content" role="status" aria-live="polite" aria-atomic="true">
            <h2 id="summary-title">{summary.title}</h2>
            <p>{summaryDescription(status, health, invalidResponse)}</p>
          </div>
          <Badge tone={summary.tone}>
            <span className="status-dot" />
            {summary.label}
          </Badge>
        </section>

        <section className="services-section" aria-labelledby="services-title">
          <div className="section-heading">
            <h2 id="services-title">Service checks</h2>
            <span>2 services</span>
          </div>
          <div className="service-grid">
            <DatabaseCard health={health} checking={status === 'checking'} />
            <WorkerCard health={health} checking={status === 'checking'} />
          </div>
        </section>

        <aside className="checks-note" aria-labelledby="checks-note-title">
          <Icon name="info" />
          <div>
            <h2 id="checks-note-title">What is being checked</h2>
            <p>
              The database check verifies connectivity and the vector extension. A worker is active
              while its heartbeat is recent. These checks report infrastructure readiness.
            </p>
          </div>
        </aside>
        <ExecutionDiagnostics />

        <footer className="page-footer">
          <span>
            Sazuz <span aria-hidden="true">/</span> System status
          </span>
          <span className="monitoring-label">
            <span className={`monitoring-dot${autoRefresh ? ' monitoring-dot-active' : ''}`} />
            {autoRefresh ? 'Refreshes every 10 seconds' : 'Automatic refresh paused'}
          </span>
        </footer>
      </main>
    </div>
  );
}
