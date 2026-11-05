'use client';
import '../lib/validation';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { approvalSchema, type Approval, type ApprovalDecision } from '@sazuz/core/missions';
import { api } from '../lib/api';
import { useWorkspaceResource, useWorkspaceSession, workspaceError } from '../lib/use-workspace';
import { ApprovalCard } from './approval-card';
import { RequestNotice } from './durable-shared';
import { WorkPageLayout } from './work-page';
import { BatchApprovalReview } from './batch-approval-review';

const approvalsSchema = z.array(approvalSchema);

export function ApprovalInbox({ missionId }: { missionId?: string }) {
  const session = useWorkspaceSession();
  const approvals = useWorkspaceResource('approvals', approvalsSchema, session.ready);
  const client = useQueryClient();
  const [filter, setFilter] = useState('pending');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  async function decide(id: string, decision: ApprovalDecision): Promise<boolean> {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const updated = await api(`approvals/${id}/decision`, approvalSchema, decision);
      client.setQueryData<Approval[]>(['workspace', 'approvals'], (items) =>
        items?.map((item) => (item.id === updated.id ? updated : item)),
      );
      await client.invalidateQueries({ queryKey: ['workspace', 'missions'] });
      setMessage(
        decision.action === 'deny'
          ? 'Action denied. Your note is available to the agent.'
          : decision.action === 'confirm_done'
            ? 'Outcome recorded as completed.'
            : 'Decision saved. The mission can continue from its checkpoint.',
      );
      return true;
    } catch (cause) {
      setError(workspaceError(cause));
      await approvals.refetch();
      return false;
    } finally {
      setBusy(false);
    }
  }
  const relevant =
    approvals.data?.filter(
      (item) =>
        (!missionId || item.missionId === missionId) &&
        (filter === 'all' || item.status === filter),
    ) ?? [];
  return (
    <WorkPageLayout
      current="Approvals"
      title="Approvals"
      description="Review exactly what your team wants to do before it acts."
      actions={<Link href="/settings?section=security">Review safety policy</Link>}
    >
      <RequestNotice error={session.error || approvals.error} message={error} />
      {message && (
        <p className="setup-notice" role="status">
          {message}
        </p>
      )}
      <div className="durable-toolbar">
        <label className="setup-field">
          Show approvals
          <select
            disabled={busy}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="denied">Denied</option>
            <option value="expired">Expired</option>
            <option value="resolved">Resolved outcomes</option>
            <option value="all">All decisions</option>
          </select>
        </label>
        {missionId && <Link href="/approvals">Show all missions</Link>}
        <button
          className="secondary"
          disabled={busy || approvals.isFetching || !session.ready}
          onClick={() => {
            void approvals.refetch();
          }}
        >
          Refresh approvals
        </button>
      </div>
      <BatchApprovalReview
        approvals={
          approvals.data?.filter((item) => !missionId || item.missionId === missionId) ?? []
        }
        now={now}
        disabled={busy || !!approvals.error}
        onBusyChange={setBusy}
        onRefresh={() => approvals.refetch()}
      />
      {(!session.ready || approvals.isPending) && !session.error && (
        <p role="status">Loading approvals…</p>
      )}
      {approvals.data && !relevant.length && (
        <section className="work-empty">
          <h2>No {filter === 'all' ? '' : `${filter} `}approvals</h2>
          <p>
            {filter === 'pending'
              ? 'Your team will pause here when an action needs your decision.'
              : 'There are no decisions in this view.'}
          </p>
        </section>
      )}
      <div className="approval-list">
        {relevant.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            now={now}
            onDecision={decide}
            busy={busy || !!approvals.error}
          />
        ))}
      </div>
    </WorkPageLayout>
  );
}
