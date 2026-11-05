'use client';
import '../lib/validation';
import { useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { costDashboardSchema, telemetryStatusSchema } from '@sazuz/core/observability';
import { projectSchema } from '@sazuz/core/work';
import { useWorkspaceResource, useWorkspaceSession } from '../lib/use-workspace';
import { WorkPageLayout } from './work-page';
import { RequestNotice } from './durable-shared';
import { formatCost } from './chat-messages';
import { WorkspaceLoading } from './workspace-section-nav';

export function CostCenter() {
  const session = useWorkspaceSession();
  const [projectId, setProjectId] = useState('');
  const projects = useWorkspaceResource('projects', z.array(projectSchema), session.ready, false);
  const dashboard = useWorkspaceResource(
    'costs/dashboard' + (projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''),
    costDashboardSchema,
    session.ready,
  );
  const telemetry = useWorkspaceResource(
    'observability/status',
    telemetryStatusSchema,
    session.ready,
  );
  const data = dashboard.data;
  return (
    <WorkPageLayout
      current="Costs"
      title="Costs"
      description="Recorded model usage, budget alerts and the current UTC month's spending pace."
      actions={<Link href="/settings?section=budgets">Budget settings</Link>}
    >
      <RequestNotice
        error={session.error || dashboard.error || projects.error || telemetry.error}
      />
      <label className="setup-field operation-filter">
        Project scope
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">Entire workspace</option>
          {projects.data?.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      {session.loading || dashboard.isPending ? (
        <WorkspaceLoading>Loading recorded usage…</WorkspaceLoading>
      ) : null}
      {data && (
        <>
          <section
            className="durable-card operation-section operation-summary"
            aria-label="Spending summary"
          >
            <h2>Month to date: {formatCost(data.costUsd)}</h2>
            <p>
              {data.monthStart.slice(0, 10)} through {data.asOf.slice(0, 10)} (UTC) · Today{' '}
              {formatCost(data.todayUsd)} · All time {formatCost(data.allTimeUsd)}
            </p>
            <p>
              Month-end forecast: <strong>{formatCost(data.forecastUsd)}</strong>. This projects the
              observed pace over {data.elapsedDays.toFixed(2)} elapsed days, with a one-day minimum.
              Future usage may differ.
            </p>
            <p>
              {data.calls} calls · {data.inputTokens.toLocaleString()} input tokens ·{' '}
              {data.outputTokens.toLocaleString()} output tokens · {data.failedCalls} failed calls ·{' '}
              {data.estimatedCalls} estimated charges. Failed-call charges are included.
            </p>
            {data.thresholds.map((limit) => (
              <p key={limit.period}>
                {limit.period === 'project'
                  ? 'Project lifetime'
                  : limit.period === 'day'
                    ? 'Daily'
                    : 'Monthly'}{' '}
                cap: {formatCost(limit.spentUsd)} / {formatCost(limit.capUsd)}
                {limit.percentUsed === null ? ' (zero cap)' : ` (${limit.percentUsed.toFixed(1)}%)`}
                . Thresholds reached:{' '}
                {limit.reached.length
                  ? limit.reached.map((value) => `${value}%`).join(', ')
                  : 'none'}
                .
              </p>
            ))}
            <p>Threshold alerts follow your notification and Calm Mode settings.</p>
          </section>
          {Object.entries(data.groups).map(([dimension, rows]) => (
            <section
              className="durable-card operation-section"
              key={dimension}
              aria-label={`Costs by ${dimension}`}
            >
              <h2>By {dimension}</h2>
              {rows.length ? (
                <div
                  className="table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label={`Costs by ${dimension} table`}
                >
                  <table>
                    <caption>Current UTC month, up to 500 groups by spend</caption>
                    <thead>
                      <tr>
                        <th scope="col">{dimension}</th>
                        <th scope="col">Cost</th>
                        <th scope="col">Calls</th>
                        <th scope="col">Input / output tokens</th>
                        <th scope="col">Failed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.key}>
                          <th scope="row">{row.label}</th>
                          <td>{formatCost(row.costUsd)}</td>
                          <td>{row.calls}</td>
                          <td>
                            {row.inputTokens.toLocaleString()} / {row.outputTokens.toLocaleString()}
                          </td>
                          <td>{row.failedCalls}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>No recorded calls this month.</p>
              )}
            </section>
          ))}
        </>
      )}
      {telemetry.data && (
        <section className="durable-card operation-section" aria-label="Telemetry export">
          <h2>OpenTelemetry export: {telemetry.data.enabled ? 'enabled' : 'off'}</h2>
          <p>
            Exports hashed operation identifiers, timing, tokens and cost to your configured
            OTLP/HTTP traces endpoint. Prompts, tool content and credentials are excluded.
          </p>
          <p>
            {telemetry.data.counts.done} exported · {telemetry.data.counts.failed} failed ·{' '}
            {telemetry.data.counts.uncertain} uncertain · {telemetry.data.counts.blocked} blocked.
            Each call has at most one export attempt; interrupted sends remain uncertain.
          </p>
          <Link href="/settings?section=advanced">Collector settings</Link>
          {telemetry.data.latest.some((item) => item.code) && (
            <p role="status">
              Latest issue:{' '}
              {telemetry.data.latest.find((item) => item.code)?.code?.replaceAll('_', ' ')}.
            </p>
          )}
        </section>
      )}
    </WorkPageLayout>
  );
}
