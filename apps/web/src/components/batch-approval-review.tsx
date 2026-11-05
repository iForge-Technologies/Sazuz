import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { approvalDecisionSchema, approvalSchema, type Approval } from '@sazuz/core/missions';
import { api, ApiError } from '../lib/api';
import { workspaceError } from '../lib/use-workspace';
import { ApprovalPreview } from './approval-preview';
import { agentLabels, LocalTime } from './durable-shared';

type Outcome = { status: 'approved' | 'conflict' | 'failed'; message: string };

export function BatchApprovalReview({
  approvals,
  now,
  disabled,
  onBusyChange,
  onRefresh,
}: {
  approvals: Approval[];
  now: number;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onRefresh: () => Promise<unknown>;
}) {
  const client = useQueryClient();
  const [review, setReview] = useState<Approval[] | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const groups = new Map<string, Approval[]>();
  for (const approval of approvals) {
    if (
      approval.kind !== 'policy' ||
      approval.status !== 'pending' ||
      new Date(approval.expiresAt).getTime() <= now
    )
      continue;
    const key = JSON.stringify([
      approval.projectId,
      approval.agentId,
      approval.toolName,
      approval.effect,
      approval.ruleId,
      approval.risk,
      approval.tainted,
    ]);
    const group = groups.get(key) ?? [];
    group.push(approval);
    groups.set(key, group);
  }
  const batches = [...groups.values()].filter((group) => group.length > 1);
  const stale =
    review?.some((item) => {
      if (outcomes[item.id]) return false;
      const latest = approvals.find((approval) => approval.id === item.id);
      return (
        !latest ||
        latest.version !== item.version ||
        latest.status !== 'pending' ||
        new Date(item.expiresAt).getTime() <= now
      );
    }) ?? false;
  const successful = Object.values(outcomes).filter(
    (outcome) => outcome.status === 'approved',
  ).length;

  async function approveBatch() {
    if (!review || !confirmed || stale || attempted || sending) return;
    setSending(true);
    setAttempted(true);
    onBusyChange(true);
    try {
      for (const item of review) {
        try {
          const updated = await api(
            `approvals/${item.id}/decision`,
            approvalSchema,
            approvalDecisionSchema.parse({ action: 'approve', version: item.version, note }),
          );
          if (updated.id !== item.id || updated.status !== 'approved')
            throw new ApiError(
              200,
              'INVALID_RESPONSE',
              'The server did not confirm this decision. Refresh to check its status.',
            );
          setOutcomes((current) => ({
            ...current,
            [item.id]: { status: 'approved', message: 'Approved for the reviewed version.' },
          }));
          client.setQueryData<Approval[]>(['workspace', 'approvals'], (items) =>
            items?.map((approval) => (approval.id === updated.id ? updated : approval)),
          );
        } catch (cause) {
          setOutcomes((current) => ({
            ...current,
            [item.id]: {
              status: cause instanceof ApiError && cause.status === 409 ? 'conflict' : 'failed',
              message: workspaceError(cause),
            },
          }));
          break;
        }
      }
      await onRefresh();
      await client.invalidateQueries({ queryKey: ['workspace', 'missions'] });
    } finally {
      setSending(false);
      onBusyChange(false);
    }
  }

  if (!batches.length && !review) return null;
  return (
    <section className="durable-card batch-approval" aria-label="Batch approvals">
      <h2>Review similar requests together</h2>
      {!review ? (
        <>
          <p>
            Each group contains pending requests for the same agent, project, tool and policy rule.
            Every action keeps its own approval and expiry.
          </p>
          <div className="durable-actions">
            {batches.map((group) => (
              <button
                className="secondary"
                key={group[0]!.id}
                disabled={disabled}
                onClick={() => {
                  setReview(structuredClone(group));
                  setConfirmed(false);
                  setNote('');
                  setAttempted(false);
                  setOutcomes({});
                }}
              >
                Review {group.length} {group[0]!.toolName} requests
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <p>
            Check every destination and message below. Approving this batch applies only to these
            exact request versions.
          </p>
          {stale && !attempted && (
            <p className="setup-error" role="status">
              A request changed or expired after this review opened. Close this review and check the
              latest requests.
            </p>
          )}
          {review.map((item, index) => (
            <article className="batch-item" aria-label={`Batch request ${index + 1}`} key={item.id}>
              <header className="durable-heading">
                <div>
                  <h3>
                    Request {index + 1}: {item.toolName}
                  </h3>
                  <p>
                    {agentLabels[item.agentId]} · Version {item.version} ·{' '}
                    <Link href={`/missions/${item.missionId}`}>View mission</Link>
                  </p>
                </div>
                <span className={`risk-tag risk-${item.risk}`}>{item.risk} risk</span>
              </header>
              <p>{item.reason}</p>
              <p className="work-muted">
                Rule {item.ruleId} · Expires <LocalTime value={item.expiresAt} />
              </p>
              {item.tainted && (
                <p className="setup-notice">
                  Proposed after reading external content. Review the destination and content
                  carefully.
                </p>
              )}
              <ApprovalPreview toolName={item.toolName} args={item.args} />
              {attempted && (
                <p
                  className={
                    outcomes[item.id]?.status === 'approved'
                      ? 'setup-notice'
                      : outcomes[item.id]
                        ? 'setup-error'
                        : 'work-muted'
                  }
                  role="status"
                >
                  {outcomes[item.id]
                    ? outcomes[item.id]!.message
                    : sending
                      ? 'Waiting for earlier requests.'
                      : 'Not attempted. Review this request separately.'}
                </p>
              )}
            </article>
          ))}
          {!attempted && (
            <>
              <label className="setup-field">
                Batch decision note
                <textarea
                  rows={2}
                  maxLength={2000}
                  value={note}
                  disabled={disabled}
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
              <label className="setup-check">
                <input
                  type="checkbox"
                  disabled={disabled || stale}
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I reviewed all {review.length} requests
              </label>
            </>
          )}
          {attempted && !sending && (
            <p className="setup-notice" role="status">
              {successful} of {review.length} requests approved.{' '}
              {successful < review.length
                ? 'The batch stopped. Changed or unconfirmed requests were not retried.'
                : 'Each mission can continue from its checkpoint.'}
            </p>
          )}
          <div className="durable-actions">
            {!attempted && (
              <button
                disabled={disabled || stale || !confirmed}
                onClick={() => {
                  void approveBatch();
                }}
              >
                Approve {review.length} reviewed requests
              </button>
            )}
            <button className="secondary" disabled={sending} onClick={() => setReview(null)}>
              Close batch review
            </button>
          </div>
        </>
      )}
    </section>
  );
}
